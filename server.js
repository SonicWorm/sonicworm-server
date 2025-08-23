const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { v4: uuidv4 } = require('uuid');
const { RateLimiterMemory } = require('rate-limiter-flexible');
require('dotenv').config();

// --- KONTROL İÇİN GEÇİCİ KOD ---
console.log("PRIVATE_KEY .env dosyasından okunuyor mu?:", process.env.PRIVATE_KEY ? "EVET, OKUNUYOR" : "HAYIR, OKUNAMIYOR veya BOŞ");
// --- KONTROL KODU BİTTİ ---

const { ethers } = require("ethers");
// GameLogic.sol'un ABI'si (Application Binary Interface) buraya gelecek.
// Bu, kontratın fonksiyonlarını JavaScript'e çeviren uzun bir JSON dizisidir.
const gameLogicAbi = require('./contract-abi.json'); 

const provider = new ethers.JsonRpcProvider("https://rpc.blaze.soniclabs.com");
const serverWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const gameContract = new ethers.Contract(process.env.VITE_GAME_CONTRACT_ADDRESS_TESTNET, gameLogicAbi, serverWallet);

console.log(`✅ Server connected to GameLogic contract at ${gameContract.target}`);


const app = express();
const PORT = process.env.PORT || 8080;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json());

// Rate limiting
const rateLimiter = new RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: 100, // Number of requests
  duration: 60, // Per 60 seconds
});

// Game state
const gameRooms = new Map();
let defaultRoomId = null; // ensure players land in the same active room
const players = new Map();

// Ack throttle state per player
const ackState = new Map(); // playerId -> { lastAckAt: number, lastX: number, lastY: number }

const lobby = new Map(); // LOBİDEKİ OYUNCULARI TUTACAK
let lobbyTimer = null;

// Minimal rate limiting
const playerMessageCounts = new Map();


// --- ÇALIŞAn EŞKİ SİSTEM LOBİ DEĞİŞKENLERİ ---
let lobbyState = 'idle'; // 'idle', 'gathering', 'waiting', 'confirming'
let confirmationTimer = null;

let lobbyTimeoutId = null; // setTimeout ID'si
let lobbyIntervalId = null; // setInterval ID'si

// Confirmation phase timers (new)
let confirmationTimeoutId = null;
let confirmationIntervalId = null;
// ------------------------------------


// SENİN KURALLARIN: Oyun sabitleri
const GAME_CONFIG = {
  MAX_PLAYERS_PER_ROOM: 30,
  WORLD_SIZE: 2500, // Increased from 2000 to 3000
  GAME_DURATION: 5 * 60 * 1000, // 5 dakika
  FOOD_COUNT: 375 // Updated to 375
};


// SENİN İSTEĞİN: 10-15 farklı oyuncu rengi
const PLAYER_COLORS = [
  0x00ffcc, // Sonic Cyan (Ana renk)
  0xff6b6b, // Coral Red
  0x4ecdc4, // Teal
  0x45b7d1, // Sky Blue
  0x96ceb4, // Mint Green
  0xfeca57, // Sunny Yellow
  0xff9ff3, // Pink
  0x54a0ff, // Blue
  0x5f27cd, // Purple
  0x00d2d3, // Cyan
  0xff9f43, // Orange
  0x10ac84, // Green
  0xee5a24, // Red Orange
  0x0abde3, // Light Blue
  0xc44569  // Dark Pink
];


class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = new Map();
    this.gameState = {
      food: [],
      startTime: null,
      isActive: false
    };

    // Minimal güvenlik: Kill protection only
    this.killLock = new Set();
    this.generateFood();
  }

  generateFood() {
    this.gameState.food = [];
    const foodMargin = 100; // Oyuncu hareket sınırı ile aynı (kenarlara 100px yaklaşabilir)
    
    for (let i = 0; i < GAME_CONFIG.FOOD_COUNT; i++) {
      this.gameState.food.push({
        id: uuidv4(),
        x: foodMargin + Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * foodMargin),
        y: foodMargin + Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * foodMargin),
        color: Math.floor(Math.random() * 0xffffff),
        size: Math.random() * 3 + 3
      });
    }
  }

  addPlayer(playerId, playerData) {
    if (this.players.size >= GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      return false;
    }


    // SENİN İSTEĞİN: Her oyuncuya farklı renk ata
    const assignedColor = this.getAvailableColor();

    // Güvenli spawn alanı - kenarlardan uzak
    const spawnMargin = 150;
    const safeX = spawnMargin + Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * spawnMargin);
    const safeY = spawnMargin + Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * spawnMargin);
    
    // Initialize segments with minimum segments
    const MIN_SEGMENTS = 5;
    const SEGMENT_SIZE = 8;
    const segments = [];
    for (let i = 0; i < MIN_SEGMENTS; i++) {
      segments.push({
        x: safeX - (i * SEGMENT_SIZE),
        y: safeY
      });
    }

    this.players.set(playerId, {
      id: playerId,
      x: safeX,
      y: safeY,
      angle: 0,
      segments: segments,
      kills: 0,
      isAlive: true,
      color: assignedColor, // SENİN İSTEĞİN: Atanmış renk
      joinTime: Date.now(),
      walletAddress: playerData.walletAddress || null, // YENİN: Cüzdan adresi
      gameId: playerData.gameId || null, // YENİ: Oyun ID'si
      ws: playerData.ws || null, // WebSocket referansı
      foodEatenCount: 0, // Food eaten counter for growth
      spawnTime: Date.now(), // Spawn time
      isInvulnerable: true, // First 10 seconds invulnerable
      ...playerData
    });

    // İlk oyuncu geldiğinde oyunu başlat
    if (this.players.size === 1 && !this.gameState.isActive) {
      this.startGame();
    }

    return true;
  }

  // SENİN İSTEĞİN: Mevcut oyuncular tarafından kullanılmayan renk seç
  getAvailableColor() {
    const usedColors = new Set();
    
    // Mevcut oyuncuların renklerini topla
    this.players.forEach(player => {
      usedColors.add(player.color);
    });
    
    // Kullanılmayan renk bul
    for (const color of PLAYER_COLORS) {
      if (!usedColors.has(color)) {
        return color;
      }
    }
    
    // Tüm renkler kullanılıyorsa rastgele bir renk döndür
    return PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)];
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    
    // Oda boşsa oyunu durdur
    if (this.players.size === 0) {
      this.gameState.isActive = false;
      this.gameState.startTime = null;
    }
  }

  broadcast(message) {
    this.players.forEach(player => {
      if (player.ws && player.ws.readyState === 1) { // WebSocket.OPEN = 1
        try {
          player.ws.send(JSON.stringify(message));
        } catch (error) {
          console.error('Failed to send message to player:', error);
        }
      }
    });
  }

  startGame() {
    this.gameState.isActive = true;
    this.gameState.startTime = Date.now();
    
    // Initialize food when game starts
    this.gameState.food = [];
    this.generateFood(GAME_CONFIG.FOOD_COUNT); // Generate initial food
    
    console.log(`🎮 Game started in room ${this.id} with ${this.gameState.food.length} food items`);
    
    // Tüm oyunculara oyun başladığını bildir
    this.broadcast({
      type: 'GAME_STARTED',
      gameState: this.gameState
    });
    
    // Otomatik yeni oyun başlatma kaldırıldı
  }

  endGame() {
    this.gameState.isActive = false;
    
    // CRITICAL FIX: Non-blocking blockchain calls - don't await, use fire-and-forget
    const resetPromises = [];
    for (const [playerId, player] of this.players) {
      if (player.gameId && player.walletAddress) {
        console.log(`🔍 Checking contract status for player ${playerId} (${player.walletAddress})`);
        
        // Fire-and-forget: don't block game loop with blockchain calls
        setImmediate(() => {
          gameContract.getPlayer(player.walletAddress)
            .then((contractPlayer) => {
              if (contractPlayer.isActive) {
                console.log(`🔄 Admin resetting active game ${player.gameId} for player ${playerId}`);
                return gameContract.adminEmergencyResetPlayer(player.walletAddress);
              } else {
                console.log(`ℹ️ Player ${playerId} is already inactive in contract, skipping reset`);
                return Promise.resolve();
              }
            })
            .then(() => console.log(`✅ Player ${playerId} processed successfully`))
            .catch((error) => console.error(`❌ Failed to process player ${playerId}:`, error.message));
        });
      }
    }
    
    console.log(`🏁 Game ended immediately - blockchain operations running in background`);
    // Return immediately - don't block game state broadcasts
  }


  updatePlayer(playerId, updateData) {
    const player = this.players.get(playerId);
    if (player && player.isAlive) {
      // Update basic properties
      if (updateData.x !== undefined) player.x = updateData.x;
      if (updateData.y !== undefined) player.y = updateData.y;  
      if (updateData.angle !== undefined) player.angle = updateData.angle;
      
      // Update segments with smooth following
      if (player.segments.length > 0) {
        player.segments[0].x = player.x;
        player.segments[0].y = player.y;
        
        const SEGMENT_SIZE = 8;
        // Smooth segment following
        for (let i = 1; i < player.segments.length; i++) {
          const prev = player.segments[i - 1];
          const curr = player.segments[i];

          const dx = prev.x - curr.x;
          const dy = prev.y - curr.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          
          if (distance > SEGMENT_SIZE) {
            const ratio = SEGMENT_SIZE / distance;
            curr.x = prev.x - dx * ratio;
            curr.y = prev.y - dy * ratio;
          }
        }
      }
      
      // Update other properties
      Object.assign(player, updateData);
    }
  }

  async killPlayer(playerId, killerId) {
    // Minimal güvenlik: Duplicate kill önleme
    const killKey = `${killerId}_${playerId}`;
    if (this.killLock.has(killKey)) {
      return false; // Already processing this kill
    }

    const player = this.players.get(playerId);
    const killer = this.players.get(killerId);
    
    if (player && killer && player.isAlive && playerId !== killerId) {
      // Lock this kill temporarily
      this.killLock.add(killKey);
      
      player.isAlive = false;
      killer.kills += 1;
      
      console.log(`⚔️ Player ${killerId} killed ${playerId}. Recording on-chain...`);
      
      // Remove lock after 1 second
      setTimeout(() => {
        this.killLock.delete(killKey);
      }, 1000);
      
      // --- BLOCKCHAIN ENTEGRASYONU ---
      try {
        // Adım 3'te sakladığımız bilgileri kullanıyoruz
        const killerGameId = killer.gameId; 
        const victimWalletAddress = player.walletAddress;

        const tx = await gameContract.recordKill(killerGameId, victimWalletAddress);
        console.log(`Transaction sent: ${tx.hash}. Waiting for confirmation...`);
        await tx.wait();
        console.log(`✅ Kill for game ${killerGameId} successfully recorded on-chain!`);
      } catch (error) {
        console.error("🔥 Failed to record kill on-chain:", error);
      }
      
      // ✅ ÖLEN OYUNCU İÇİN adminReset() ÇAĞIR
      if (player.gameId && player.walletAddress) {
        try {
          console.log(`🔄 Admin resetting killed player ${playerId} (${player.walletAddress}, gameId: ${player.gameId})`);
          await gameContract.adminEmergencyResetPlayer(player.walletAddress);
          console.log(`✅ Killed player ${playerId} reset successfully`);
        } catch (error) {
          console.error(`❌ Failed to reset killed player ${playerId}:`, error.message);
        }
      }
      // --- BİTTİ ---
      
      // Ölen oyuncuyu yem haline getir
      this.createFoodFromPlayer(player);
      
      // Ölen oyuncuya game over mesajı gönder
      if (player.ws && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify({
          type: 'PLAYER_KILLED',
          message: 'You were killed! Returning to main menu...'
        }));
      }

      return true;
    }
    
    return false;
  }

  createFoodFromPlayer(player) {
    // Oyuncunun segmentlerini yem haline getir
    player.segments.forEach((segment) => {
      for (let i = 0; i < 3; i++) {
        this.gameState.food.push({
          id: uuidv4(),
          x: segment.x + (Math.random() - 0.5) * 40,
          y: segment.y + (Math.random() - 0.5) * 40,
          color: player.color,
          size: Math.random() * 4 + 4
        });
      }
    });
  }

  // SERVER AUTHORITY: Food Collision Detection
  checkFoodCollisions() {
    const players = Array.from(this.players.values()).filter(p => p.isAlive);
    const SEGMENT_SIZE = 8;
    
    for (const player of players) {
      if (!player.isAlive || !player.segments || player.segments.length === 0) continue;
      
      const playerHead = player.segments[0];
      if (!playerHead) continue;
      
      const headRadius = SEGMENT_SIZE / 2;
      
      // Check food collisions
      for (let i = this.gameState.food.length - 1; i >= 0; i--) {
        const foodItem = this.gameState.food[i];
        const distance = Math.sqrt(
          Math.pow(playerHead.x - foodItem.x, 2) + 
          Math.pow(playerHead.y - foodItem.y, 2)
        );
        
        if (distance < headRadius + foodItem.size) {
          // Remove eaten food
          this.gameState.food.splice(i, 1);
          
          // Player growth logic
          player.foodEatenCount = (player.foodEatenCount || 0) + 1;
          
          if (player.foodEatenCount >= 3) {
            // Add new segment - PERMANENT GROWTH (max 50 segments)
            if (player.segments.length < 50) { // Sadece bu kontrol yeterli
              const lastSegment = player.segments[player.segments.length - 1];
              player.segments.push({
                x: lastSegment.x,
                y: lastSegment.y
              });
              console.log(`🎉 GROWTH! Player ${player.id} segments: ${player.segments.length}`);
            } else {
              console.log(`🚫 Max segments reached! Player ${player.id} at ${player.segments.length} segments`);
            }
            player.foodEatenCount = 0; // Reset counter
          }
          
          // Generate new food
          this.generateFood(1);
          
          // Broadcast minimal food delta
          this.broadcast({
            type: 'FOOD_CREATED',
            newFood: [{ id: foodItem.id, x: foodItem.x, y: foodItem.y, color: foodItem.color, size: foodItem.size }]
          });
        }
      }
    }
  }

  // SERVER AUTHORITY: Food Generation
  generateFood(count = 1) {
    const sonicColors = [0x00ffcc, 0xff6600, 0x0099ff, 0xff0066, 0x66ff00];
    const foodMargin = 100; // Oyuncu hareket sınırı ile aynı
    
    for (let i = 0; i < count; i++) {
      this.gameState.food.push({
        id: require('crypto').randomUUID(),
        x: Math.floor(Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * foodMargin)) + foodMargin,
        y: Math.floor(Math.random() * (GAME_CONFIG.WORLD_SIZE - 2 * foodMargin)) + foodMargin,
        color: sonicColors[Math.floor(Math.random() * sonicColors.length)],
        size: Math.floor(Math.random() * 4) + 4
      });
    }
  }

  // SERVER AUTHORITY: Game Timer Management
  updateGameTimer() {
    if (!this.gameState.startTime) return;
    
    const currentTime = Date.now();
    const elapsedTime = currentTime - this.gameState.startTime;
    const timeRemaining = Math.max(0, GAME_CONFIG.GAME_DURATION - elapsedTime);
    
    // Update game state
    this.gameState.timeRemaining = timeRemaining;
    
    // Check if game should end
    if (timeRemaining <= 0 && this.gameState.isActive) {
      console.log('⏰ Game time ended - ending game');
      
      // Mark game as inactive
      this.gameState.isActive = false;
      
      // Game ended by timer - trigger endMatch for this room
      // Bu room'u endMatch queue'suna ekle
      process.nextTick(() => {
        // Find this room in the global gameRooms and call endMatch
        for (const [roomId, room] of gameRooms) {
          if (room === this) {
            endMatch(room);
            break;
          }
        }
      });
    }
    
    // ✅ Broadcast timer update every 1 second (not every 5 seconds)
    if (elapsedTime % 1000 < 20) { // Every ~1 second (20ms tolerance for 60fps)
      this.broadcast({
        type: 'TIMER_UPDATE',
        timeRemaining: timeRemaining,
        elapsedTime: elapsedTime
      });
    }
  }


  // SERVER AUTHORITY: Collision Detection Engine
  checkCollisions() {
    const players = Array.from(this.players.values()).filter(p => p.isAlive);
    const SEGMENT_SIZE = 16; // Daha büyük collision area
    
    // Update invulnerability status
    const currentTime = Date.now();
    players.forEach(player => {
      if (player.isInvulnerable) {
        const invulnerabilityDuration = 10000; // 10 seconds
        const spawnElapsed = currentTime - (player.spawnTime || player.joinTime);
        if (spawnElapsed >= invulnerabilityDuration) {
          player.isInvulnerable = false;
          console.log(`🛡️ Player ${player.id} invulnerability ended`);
        }
      }
    });
    
    // 🔍 DEBUG: Collision check info
    if (players.length >= 2) {
      console.log(`🔍 COLLISION CHECK: ${players.length} alive players`);
      players.forEach(p => {
        console.log(`  Player ${p.id}: segments=${p.segments?.length || 0}, head=${p.segments?.[0] ? 
          `(${Math.round(p.segments[0].x)},${Math.round(p.segments[0].y)})` : 'no head'}`);
      });
    }
    
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (!player.isAlive || !player.segments || player.segments.length === 0) continue;
      
      const playerHead = player.segments[0];
      if (!playerHead) continue;
      
      // Diğer oyuncularla çarpışma kontrolü
      for (let j = 0; j < players.length; j++) {
        if (i === j) continue; // Kendisiyle çarpışma kontrolü yok
        
        const otherPlayer = players[j];
        if (!otherPlayer.isAlive || !otherPlayer.segments) continue;
        
        // Diğer oyuncunun tüm segmentleri ile çarpışma
        for (let segIndex = 0; segIndex < otherPlayer.segments.length; segIndex++) {
          const segment = otherPlayer.segments[segIndex];
          
          const distance = Math.sqrt(
            Math.pow(playerHead.x - segment.x, 2) + 
            Math.pow(playerHead.y - segment.y, 2)
          );
          
          // Çarpışma tespit edildi
          if (distance < SEGMENT_SIZE) {
            // Check if either player is invulnerable
            if (player.isInvulnerable || otherPlayer.isInvulnerable) {
              console.log(`🛡️ COLLISION BLOCKED: ${player.id} vs ${otherPlayer.id} - invulnerability active`);
              continue;
            }
            
            console.log(`🚨 SERVER COLLISION: ${player.id} hit ${otherPlayer.id} at distance ${Math.round(distance)}`);
            
            // Kill sayısını artır (killPlayer çağrılmadan önce)
            otherPlayer.kills = (otherPlayer.kills || 0) + 1;
            
            // 🎯 killPlayer fonksiyonunu çağır - Bu yem yaratma, broadcast vs. yapacak
            const killed = this.killPlayer(player.id, otherPlayer.id);
            
            if (killed) {
              console.log(`💀 Player ${player.id} killed by ${otherPlayer.id} (kills: ${otherPlayer.kills})`);
              
              // BROADCAST THE KILL TO THE ROOM
              this.broadcast({
                  type: 'PLAYER_KILLED',
                  killerId: otherPlayer.id,
                  victimId: player.id,
                  gameState: this.getGameState() // Include updated state
              });
              
              return; // Bu oyuncu öldü, diğer çarpışmaları kontrol etme
            }
          }
        }
      }
    }
  }
  
  async recordKillToBlockchain(killer, victim) {
    try {
      if (killer.gameId && victim.walletAddress) {
        console.log(`📝 Recording kill to blockchain: ${killer.id} → ${victim.id}`);
        const tx = await gameContract.recordKill(killer.gameId, victim.walletAddress);
        await tx.wait();
        console.log(`✅ Kill recorded on blockchain: ${tx.hash}`);
      }
    } catch (error) {
      console.error(`❌ Blockchain kill record failed:`, error.message);
    }
  }

  // SERVER AUTHORITY: Prize Pool Calculation
  calculatePrizePool() {
    // YENİ FORMULA: Her oyuncudan 3 S prize pool'a gider (%60)
    const playerCount = this.players.size;
    const prizePoolPerPlayer = 3.0; // ✅ Her oyuncudan 3 S (5 S'nin %60'ı)
    return playerCount * prizePoolPerPlayer;
  }

  // PRIZE DISTRIBUTION ALGORITHM: %50/%30/%20 + BERABERLIK
  calculatePrizeDistribution(finalLeaderboard) {
    const totalPrize = this.calculatePrizePool();
    const distributions = [];
    
    if (finalLeaderboard.length === 0) return distributions;
    
    // Only survivors can win prizes
    const eligibleWinners = finalLeaderboard.filter(p => p.isAlive);
    
    if (eligibleWinners.length === 0) {
      console.log('🏆 No survivors - no prize distribution');
      return distributions;
    }
    
    // ✅ DUPLICATE CÜZDAN KONTROLÜ - Aynı cüzdan sadece 1 kez ödül alsın
    const uniqueWinners = [];
    const seenWallets = new Set();
    
    for (const winner of eligibleWinners) {
      if (!seenWallets.has(winner.walletAddress)) {
        seenWallets.add(winner.walletAddress);
        uniqueWinners.push(winner);
      } else {
        console.log(`⚠️ Duplicate wallet detected: ${winner.walletAddress} (player ${winner.id}) - skipped`);
      }
    }
    
    console.log(`🔍 Eligible players: ${eligibleWinners.length} → Unique wallets: ${uniqueWinners.length}`);
    
    if (uniqueWinners.length === 0) {
      console.log('🏆 No unique winners - no prize distribution');
      return distributions;
    }
    
    // Group winners by kill count for tie handling
    const killGroups = {};
    uniqueWinners.forEach(player => {
      const kills = player.kills || 0;
      if (!killGroups[kills]) killGroups[kills] = [];
      killGroups[kills].push(player);
    });
    
    // Sort kill groups descending
    const sortedKillCounts = Object.keys(killGroups).map(Number).sort((a, b) => b - a);
    
    // Prize percentages
    const prizePercentages = [0.50, 0.30, 0.20]; // 1st: 50%, 2nd: 30%, 3rd: 20%
    let currentPosition = 0;
    let remainingPercentage = 1.0;
    
    for (const killCount of sortedKillCounts) {
      const playersInGroup = killGroups[killCount];
      const groupSize = playersInGroup.length;
      
      // Calculate percentage for this group
      let groupPercentage = 0;
      for (let i = 0; i < groupSize && currentPosition + i < prizePercentages.length; i++) {
        groupPercentage += prizePercentages[currentPosition + i];
      }
      
      // If some players in group exceed top 3, redistribute
      if (currentPosition >= 3) {
        // Dead players' prize redistributed to survivors
        break;
      }
      
      // Equal split within the group
      const individualPercentage = groupPercentage / groupSize;
      const individualPrize = totalPrize * individualPercentage;
      
      playersInGroup.forEach(player => {
        distributions.push({
          walletAddress: player.walletAddress,
          playerId: player.id,
          position: currentPosition + 1,
          kills: player.kills,
          prize: individualPrize,
          percentage: individualPercentage * 100
        });
      });
      
      currentPosition += groupSize;
      remainingPercentage -= groupPercentage;
      
      // Only top 3 positions get prizes
      if (currentPosition >= 3) break;
    }
    
    console.log('🏆 Prize Distribution:', distributions);
    return distributions;
  }

  getGameState() {
    // CRITICAL FIX: Ensure ALL players are always included with valid data
    const sanitizedPlayers = Array.from(this.players.values()).map((p) => {
      // Ensure head segment always matches current position
      let segments = Array.isArray(p.segments) ? p.segments : [];
      if (segments.length > 0) {
        segments[0].x = p.x;
        segments[0].y = p.y;
      }
      
      return {
        id: p.id,
        x: p.x || 1250,  // Force valid position
        y: p.y || 1250,  // Force valid position
        angle: p.angle || 0,
        // CRITICAL: Ensure segments head matches position
        segments: segments,
        segmentCount: segments.length,
        kills: p.kills || 0,
        isAlive: p.isAlive !== false,  // Force true unless explicitly false
        color: p.color || 0x00ffcc,
        spawnTime: p.spawnTime || Date.now(),
        isInvulnerable: p.isInvulnerable || false,
        walletAddress: p.walletAddress || null
      };
    });

    return {
      players: sanitizedPlayers,
      food: this.gameState.food,
      isActive: this.gameState.isActive,
      startTime: this.gameState.startTime,
      timeRemaining: this.gameState.startTime ?
        Math.max(0, GAME_CONFIG.GAME_DURATION - (Date.now() - this.gameState.startTime)) : 0,
      prizePool: this.calculatePrizePool()
    };
  }
}

// WebSocket Server  
const WS_PORT = parseInt(PORT) + 1;
const wss = new WebSocket.Server({ 
  port: WS_PORT,
  verifyClient: (info) => {
    // Rate limiting check
    return true; // Basit implementasyon
  }
});

wss.on('connection', (ws, req) => {
  const playerId = uuidv4();
  let currentRoom = null;
  
  console.log(`🔗 Player ${playerId} connected`);
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      // Minimal rate limiting - sadece PLAYER_KILL için
      if (data.type === 'PLAYER_KILL') {
        const now = Date.now();
        const key = `${playerId}_kill`;
        const lastKill = playerMessageCounts.get(key) || 0;
        
        if (now - lastKill < 200) { // 200ms kill cooldown
          return; // Ignore too frequent kills
        }
        
        playerMessageCounts.set(key, now);
      }
      
      switch (data.type) {
        case 'JOIN_LOBBY':
          // Cüzdan adresini her zaman `playerData` içinden al
          const walletAddress = data.playerData?.walletAddress;
          console.log("JOIN_LOBBY wallet:", walletAddress);

          // Cüzdan adresi olmadan lobiye girişi engelle
          if (!walletAddress) {
            console.log(`⚠️ Player ${playerId} tried to join without a wallet address. Request ignored.`);
            ws.send(JSON.stringify({
              type: 'ERROR',
              message: 'Wallet address is required to join the lobby.'
            }));
            break;
          }


          // --- GÜNCELLENMİŞ KONTROL ---
          let isAlreadyInLobby = false;
          for (const player of lobby.values()) {
            // walletAddress'ı playerData içinden kontrol et
            if (player.playerData?.walletAddress === walletAddress) {
              isAlreadyInLobby = true;
              break;
            }
          }

          if (isAlreadyInLobby) {
            console.log(`⚠️ Player with wallet ${walletAddress} is already in the lobby. Request ignored.`);
            ws.send(JSON.stringify({
              type: 'ERROR',
              message: 'You are already in the lobby.'
            }));
            break;
          }
          // --- KONTROL BİTTİ ---

          lobby.set(playerId, {
            ws,
            playerData: data.playerData, // Bütün playerData'yı sakla
            confirmed: false
          });
          console.log(`🎮 Player ${playerId} (${walletAddress}) joined lobby. Total in lobby: ${lobby.size}`);
          
          // Lobi durumunu tüm oyunculara yayınla
          broadcastLobbyStatus();
          
          // ESKİ ÇALIŞAn SİSTEM MANTIĞI: Oyuncu sayısına göre karar ver
          if (lobby.size === 1) {
            lobbyState = 'gathering'; // 1 kişi varsa 'toplanıyor' durumuna geç
          } else if (lobby.size >= 2 && lobbyState !== 'waiting') {
            // 2 veya daha fazla kişi olduysa VE sayaç zaten çalışmıyorsa, sayacı başlat
            startLobbyTimer();
          }
          
          // Eğer lobi MAX_PLAYERS_PER_ROOM sınırına ulaştıysa, oyunu başlat
          if (lobby.size >= GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
            startMatchmaking();
          }
          break;
          
        case 'LEAVE_LOBBY':
          const leavingPlayer = lobby.get(playerId);
          
          // V3: Emergency reset (güvenli çözüm)
          if (leavingPlayer && leavingPlayer.playerData?.walletAddress) {
            // Fire-and-forget: blockchain çağrısını event döngüsünü bloklamadan yap
            console.log(`🔄 Emergency reset for leaving player ${playerId} (${leavingPlayer.playerData.walletAddress})`);
            void gameContract
              .adminEmergencyResetPlayer(leavingPlayer.playerData.walletAddress)
              .then(() => {
                console.log(`✅ Player ${playerId} reset successfully on leave queue`);
                if (leavingPlayer.ws.readyState === WebSocket.OPEN) {
                  leavingPlayer.ws.send(JSON.stringify({
                    type: 'PLAYER_RESET',
                    message: 'You have been reset and can rejoin games'
                  }));
                }
              })
              .catch((error) => {
                console.error(`❌ Failed to reset leaving player ${playerId}:`, error.message);
                if (leavingPlayer.ws && leavingPlayer.ws.readyState === WebSocket.OPEN) {
                  leavingPlayer.ws.send(JSON.stringify({
                    type: 'ERROR',
                    message: 'Player reset failed - Blockchain error'
                  }));
                }
              });
          } else {
            console.log(`⚠️ No wallet address found for leaving player ${playerId}`);
          }
          
          lobby.delete(playerId);
          console.log(`🚪 Player ${playerId} left. Total: ${lobby.size}`);
          
          // UPDATED: Handle timer reset for all lobby states
          if (lobby.size < 2) {
            if (lobbyState === 'waiting') {
              console.log('✋ Player count dropped below 2, stopping waiting timer.');
              clearTimeout(lobbyTimeoutId);
              clearInterval(lobbyIntervalId);
              lobbyTimer = null;
              lobbyState = lobby.size === 1 ? 'gathering' : 'idle';
            } else if (lobbyState === 'confirming') {
              console.log('✋ Player count dropped below 2 during confirmation, canceling match.');
              clearTimeout(confirmationTimeoutId);
              clearInterval(confirmationIntervalId);
              confirmationTimer = null;
              lobbyState = lobby.size === 1 ? 'gathering' : 'idle';

              // Notify remaining players
              lobby.forEach(player => {
                if (player.ws.readyState === WebSocket.OPEN) {
                  player.ws.send(JSON.stringify({
                    type: 'MATCH_CANCELED',
                    message: 'Match canceled - not enough players'
                  }));
                }
              });
            }
          } else if (lobby.size === 0) {
            // Reset all timers when lobby is empty
            clearTimeout(lobbyTimeoutId);
            clearInterval(lobbyIntervalId);
            clearTimeout(confirmationTimeoutId);
            clearInterval(confirmationIntervalId);
            lobbyState = 'idle';
            lobbyTimer = null;
            confirmationTimer = null;
          }
          broadcastLobbyStatus();
          break;
          
        case 'CONFIRM_JOIN':
          // Oyuncu oyuna katılmaya hazır olduğunu onaylar
          const lobbyPlayer = lobby.get(playerId);
          if (lobbyPlayer && lobbyState === 'confirming') { // Sadece onay aşamasındaysa
            lobbyPlayer.confirmed = true;
            console.log(`✅ Player ${playerId} confirmed join (gameID: ${lobbyPlayer.playerData.gameId || 'none'})`);
            broadcastLobbyStatus(); // Güncel onay sayısını herkese gönder
          }
          break;
          
        case 'JOIN_GAME':
          // CRITICAL FIX: Always process JOIN_GAME fully for proper multiplayer sync
          const existing = players.get(playerId);
          if (existing && gameRooms.has(existing.roomId)) {
            const room = gameRooms.get(existing.roomId);
            // Update WebSocket reference for reconnection
            existing.ws = ws;
            // Re-send game state
            ws.send(JSON.stringify({
              type: 'GAME_JOINED',
              playerId,
              roomId: existing.roomId,
              gameState: room.getGameState()
            }));
            // CRITICAL: Also broadcast PLAYER_JOINED to ensure all clients see this player
            const p = room.players.get(playerId);
            if (p) {
              broadcastToRoom(room.id, {
                type: 'PLAYER_JOINED',
                player: {
                  id: p.id,
                  x: p.x,
                  y: p.y,
                  angle: p.angle,
                  segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
                  kills: p.kills || 0,
                  isAlive: !!p.isAlive,
                  color: p.color
                }
              }, playerId); // Exclude self from broadcast
            }
            break;
          }

          currentRoom = findOrCreateRoom();
          const joined = currentRoom.addPlayer(playerId, data.playerData);
          
          // Reduced logs for performance
          
          if (joined) {
            // Close stale ws if exists for same playerId
            const prev = players.get(playerId);
            if (prev && prev.ws && prev.ws.readyState === WebSocket.OPEN) {
              try { prev.ws.close(); } catch {}
            }
            players.set(playerId, { ws, roomId: currentRoom.id });
            
            ws.send(JSON.stringify({
              type: 'GAME_JOINED',
              playerId,
              roomId: currentRoom.id,
              gameState: currentRoom.getGameState()
            }));
            
            // Diğer oyunculara yeni oyuncu bilgisini gönder
            const p = currentRoom.players.get(playerId);
            broadcastToRoom(currentRoom.id, {
              type: 'PLAYER_JOINED',
              player: {
                id: p.id,
                x: p.x,
                y: p.y,
                angle: p.angle,
                segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
                kills: p.kills || 0,
                isAlive: !!p.isAlive,
                color: p.color,
                walletAddress: p.walletAddress || null
              }
            }, playerId);
          } else {
            ws.send(JSON.stringify({
              type: 'ERROR',
              message: 'Room is full'
            }));
          }
          break;
          
        case 'PLAYER_UPDATE':
          if (currentRoom && data.playerData) {
            // Minimal position validation
            const pos = data.playerData;
            if (pos.x >= 0 && pos.x <= GAME_CONFIG.WORLD_SIZE && pos.y >= 0 && pos.y <= GAME_CONFIG.WORLD_SIZE) {
              currentRoom.updatePlayer(playerId, data.playerData);

              // Throttled reconciliation ack to reduce rubber-banding
              const player = currentRoom.players.get(playerId);
              if (player && ws.readyState === WebSocket.OPEN) {
                const now = Date.now();
                const state = ackState.get(playerId) || { lastAckAt: 0, lastX: player.x, lastY: player.y };
                const dt = now - state.lastAckAt;
                const dx = Math.abs(player.x - state.lastX);
                const dy = Math.abs(player.y - state.lastY);
                const manhattan = dx + dy;
                // Ack if 1) at least 120ms passed OR 2) movement significant (>10 px)
                if (dt >= 120 || manhattan > 10) {
                  ws.send(JSON.stringify({
                    type: 'PLAYER_UPDATE_ACK',
                    playerId,
                    serverPosition: {
                      x: player.x,
                      y: player.y,
                      angle: player.angle,
                      inputSequence: data.playerData?.inputSequence ?? 0,
                      serverTimestamp: now
                    }
                  }));
                  ackState.set(playerId, { lastAckAt: now, lastX: player.x, lastY: player.y });
                }
              }

              // Broadcast sanitized update to other players
              broadcastToRoom(currentRoom.id, {
                type: 'PLAYER_UPDATE',
                playerId,
                playerData: {
                  x: pos.x,
                  y: pos.y,
                  angle: pos.angle,
                  segments: Array.isArray(pos.segments) ? pos.segments : []
                }
              }, playerId);
            }
          }
          break;
          
        case 'PLAYER_KILL':
          // REMOVED FOR SECURITY - Kills are now determined exclusively by server-side collision detection.
          // The client can no longer tell the server it has killed another player.
          console.log(`⚠️ Received deprecated PLAYER_KILL event from client ${playerId}. Ignoring.`);
          break;
          
        case 'PING':
          ws.send(JSON.stringify({ type: 'PONG', timestamp: Date.now() }));
          break;
      }
    } catch (error) {
      console.error('Message handling error:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: 'Invalid message format'
      }));
    }
  });
  
  ws.on('close', () => {
    console.log(`🔌 Player ${playerId} disconnected`);
    
    // Lobiden disconnect olan oyuncuya can iade et
    const disconnectedLobbyPlayer = lobby.get(playerId);
    if (disconnectedLobbyPlayer && disconnectedLobbyPlayer.playerData.gameId) {
      // ✅ No need to refund life - it was never consumed during lobby phase
      console.log(`🔄 Player ${playerId} disconnected from lobby - game was only reserved, no life consumed`);
      // Life will be automatically available since it was never spent
      lobby.delete(playerId);
      
      // Lobby durumunu güncelle (waiting + confirming temizliği)
      if (lobby.size < 2) {
        if (lobbyState === 'waiting') {
          console.log('✋ Player count dropped below 2 due to disconnect, stopping waiting timer.');
          clearTimeout(lobbyTimeoutId);
          clearInterval(lobbyIntervalId);
          lobbyTimer = null;
          lobbyState = lobby.size === 1 ? 'gathering' : 'idle';
        } else if (lobbyState === 'confirming') {
          console.log('✋ Player count dropped below 2 during confirmation due to disconnect, canceling match.');
          clearTimeout(confirmationTimeoutId);
          clearInterval(confirmationIntervalId);
          confirmationTimer = null;
          lobbyState = lobby.size === 1 ? 'gathering' : 'idle';
          // Notify remaining players
          lobby.forEach(player => {
            if (player.ws.readyState === WebSocket.OPEN) {
              player.ws.send(JSON.stringify({
                type: 'MATCH_CANCELED',
                message: 'Match canceled - not enough players'
              }));
            }
          });
        }
      } else if (lobby.size === 0) {
        // Reset all timers when lobby is empty
        clearTimeout(lobbyTimeoutId);
        clearInterval(lobbyIntervalId);
        clearTimeout(confirmationTimeoutId);
        clearInterval(confirmationIntervalId);
        lobbyState = 'idle';
        lobbyTimer = null;
        confirmationTimer = null;
      }
      broadcastLobbyStatus();
    }
    
    if (currentRoom) {
      currentRoom.removePlayer(playerId);
      
      broadcastToRoom(currentRoom.id, {
        type: 'PLAYER_LEFT',
        playerId
      }, playerId);
    }
    
    players.delete(playerId);
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function findOrCreateRoom() {
  // CRITICAL FIX: Always ensure defaultRoomId points to a valid, non-full room
  
  // First: validate defaultRoomId is still usable
  if (defaultRoomId && gameRooms.has(defaultRoomId)) {
    const defaultRoom = gameRooms.get(defaultRoomId);
    if (defaultRoom.players.size < GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      console.log(`🎯 Using existing default room: ${defaultRoomId} (${defaultRoom.players.size}/${GAME_CONFIG.MAX_PLAYERS_PER_ROOM})`);
      return defaultRoom;
    } else {
      // Default room is full, invalidate it
      console.log(`❌ Default room ${defaultRoomId} is full, invalidating`);
      defaultRoomId = null;
    }
  }

  // Second: scan for ANY available room to become new default
  for (const [roomId, room] of gameRooms) {
    if (room.players.size < GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
      defaultRoomId = roomId;
      console.log(`🔄 Setting new default room: ${roomId} (${room.players.size}/${GAME_CONFIG.MAX_PLAYERS_PER_ROOM})`);
      return room;
    }
  }

  // Third: all rooms full, create new room as default
  const roomId = uuidv4();
  const room = new GameRoom(roomId);
  gameRooms.set(roomId, room);
  defaultRoomId = roomId;
  console.log(`🏠 Created new default room: ${roomId}`);
  return room;
}


function broadcastToRoom(roomId, message, excludePlayerId = null) {
  const room = gameRooms.get(roomId);
  if (!room) return;
  
  room.players.forEach((player, playerId) => {
    if (playerId !== excludePlayerId) {
      const playerConnection = players.get(playerId);
      if (playerConnection && playerConnection.ws.readyState === WebSocket.OPEN) {
        playerConnection.ws.send(JSON.stringify(message));
      }
    }
  });
}

// Game state broadcast (60 Hz) + COLLISION DETECTION + FOOD SYSTEM + TIMER
setInterval(() => {
  gameRooms.forEach((room) => {
    if (room.gameState.isActive && room.players.size > 0) {
      // SERVER AUTHORITY: All game logic
      room.checkCollisions();        // Player vs Player collision
      room.checkFoodCollisions();    // Player vs Food collision  
      room.updateGameTimer();        // Game timer management
      
      // Broadcast sanitized game state
      const gameState = room.getGameState();
      
      // Debug logs removed for performance
      
      broadcastToRoom(room.id, {
        type: 'GAME_STATE',
        gameState: gameState
      });

      // Additional lightweight UI update (optional)
      broadcastToRoom(room.id, {
        type: 'GAME_STATE_UPDATE',
        prizePool: room.calculatePrizePool(),
        players: gameState.players,
        connectedCount: room.players.size,
        timeRemaining: gameState.timeRemaining
      });
    }
  });
}, 1000 / 60); // 60 FPS for smoother real-time


// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    rooms: gameRooms.size,
    players: players.size,
    timestamp: new Date().toISOString()
  });
});

// Game stats endpoint
app.get('/stats', (req, res) => {
  const stats = {
    totalRooms: gameRooms.size,
    totalPlayers: players.size,
    activeGames: 0,
    rooms: []
  };
  
  gameRooms.forEach((room) => {
    if (room.gameState.isActive) stats.activeGames++;
    
    stats.rooms.push({
      id: room.id,
      players: room.players.size,
      isActive: room.gameState.isActive,
      timeRemaining: room.gameState.startTime ? 
        Math.max(0, GAME_CONFIG.GAME_DURATION - (Date.now() - room.gameState.startTime)) : 0
    });
  });
  
  res.json(stats);
});


const server = app.listen(PORT, () => {
  console.log(`🚀 Sonic Snake Server running on port ${PORT}`);
  console.log(`🎮 WebSocket server running on port ${WS_PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Server shutting down...');
  
  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close();
  });
  
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});


// Lobi fonksiyonları - ESKİ ÇALIŞAn SİSTEM
function broadcastLobbyStatus() {
  // Onay aşamasındaysak, onay veren oyuncu sayısını hesapla
  const confirmedCount = Array.from(lobby.values()).filter(p => p.confirmed).length;

  const lobbyStatus = {
    type: 'LOBBY_UPDATE', // Mesaj tipini daha genel bir hale getirdik
    players: lobby.size,
    lobbyState: lobby.size === 1 ? 'gathering' : (lobby.size >= 2 ? (lobbyState === 'idle' ? 'gathering' : lobbyState) : 'idle'), // 1+ kişi için gathering
    maxPlayers: GAME_CONFIG.MAX_PLAYERS_PER_ROOM,
    confirmedCount: confirmedCount,
    // Hangi sayacın aktif olduğuna göre doğru zamanı gönder
    timeRemaining: lobbyState === 'waiting' 
      ? (lobbyTimer ? Math.max(0, 60000 - (Date.now() - lobbyTimer)) : 0)
      : (confirmationTimer ? Math.max(0, 15000 - (Date.now() - confirmationTimer)) : 0)
  };
  
  // Mesajı tüm lobi oyuncularına gönder
  lobby.forEach((player) => {
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify(lobbyStatus));
    }
  });
}

function startLobbyTimer() {
  console.log('⏰ Starting lobby waiting timer (60 seconds)');
  lobbyTimer = Date.now();
  lobbyState = 'waiting';
  // Her saniye durumu yayınla
  lobbyIntervalId = setInterval(() => {
    if (lobbyState !== 'waiting') {
      clearInterval(lobbyIntervalId);
      return;
    }
    broadcastLobbyStatus();
  }, 1000);
  // 60 saniye sonra
  lobbyTimeoutId = setTimeout(() => {
    clearInterval(lobbyIntervalId);
    if (lobbyState !== 'waiting' || lobby.size < 2) return;
    startMatchmaking();
  }, 60000);
}

function startMatchmaking() {
  console.log('🎯 Starting confirmation phase (15 seconds)...');
  lobbyState = 'confirming'; // Durumu 'onayda' yap
  confirmationTimer = Date.now();

  // Her saniye durumu yayınla
  confirmationIntervalId = setInterval(() => {
    if (lobbyState !== 'confirming') {
      clearInterval(confirmationIntervalId);
      return;
    }
    broadcastLobbyStatus();
  }, 1000);

  // 15 saniyelik onay sayacı başlat
  confirmationTimeoutId = setTimeout(async () => {
    // confirmedPlayers'ı hem ID hem de player verisi içerecek şekilde alıyoruz
    const confirmedPlayers = Array.from(lobby.entries())
      .filter(([id, player]) => player.confirmed)
      .map(([id, player]) => ({ id, ...player })); // ID'yi objeye ekliyoruz

    if (confirmedPlayers.length >= 2) {
      const playerAddresses = confirmedPlayers.map(p => p.playerData.walletAddress);
      const gameIds = confirmedPlayers.map(p => p.playerData.gameId);
      
      console.log(`[V2] Starting match with reserved games:`, gameIds);
      
      try {
        console.log(`[Blockchain] Attempting to start match for: ${playerAddresses.join(", ")}`);
        console.log(`[Blockchain] With gameIds: ${gameIds.join(", ")}`);
        
        // YENİ V2: startMatch fonksiyonunu gameIds ile çağır
        const tx = await gameContract.startMatch(playerAddresses, gameIds, {
          gasLimit: 500000
        });
        console.log(`[Blockchain] Transaction sent: ${tx.hash}. Waiting for confirmation...`);
        await tx.wait();
        console.log(`✅ [Blockchain] Match successfully started on-chain with life consumption!`);
        // SADECE KONTRAKT BAŞARILI OLURSA OYUNU SUNUCUDA BAŞLAT
        createGameFromLobby(confirmedPlayers);
      } catch (error) {
        console.error("🔥 [Blockchain] Failed to start match on-chain:", error.reason || error.message);
        
        // Oyunculara oyunun başlayamadığını bildir
        confirmedPlayers.forEach(player => {
          if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify({
              type: 'MATCH_FAILED',
              message: 'The game could not be started. Please try again.'
            }));
          }
        });
        // Lobiyi temizle
        lobby.clear();
        lobbyTimer = null;
      }
    } else {
      console.log(`❌ Not enough confirmed players (${confirmedPlayers.length}), handling refunds...`);
      
      // ONAYLAYAN OYUNCULARA CAN İADE ET
      for (const confirmedPlayer of confirmedPlayers) {
        try {
          if (confirmedPlayer.playerData.gameId) {
            // ✅ No blockchain refund needed - life was never consumed during lobby/confirmation phase
            console.log(`🔄 Player ${confirmedPlayer.id} - game was only reserved, no life consumed`);
            
            // Frontend'e bilgi gönder
            if (confirmedPlayer.ws.readyState === WebSocket.OPEN) {
              confirmedPlayer.ws.send(JSON.stringify({
                type: 'LIFE_REFUNDED',
                message: 'Game canceled due to insufficient players. Your life was not consumed.'
              }));
            }
          }
        } catch (error) {
          console.error(`❌ Failed to process player ${confirmedPlayer.id}:`, error);
        }
      }
      
      // Onaylamayan oyuncuları reset et
      for (const [id, player] of lobby.entries()) {
        if (!player.confirmed && player.playerData?.walletAddress) {
          try {
            await gameContract.adminEmergencyResetPlayer(player.playerData.walletAddress);
            console.log(`🔄 Reset unconfirmed player ${id} (${player.playerData.walletAddress})`);
          } catch (error) {
            console.error(`❌ Failed to reset player ${id}:`, error.message);
          }
        }
      }
      
      // TÜM OYUNCULARI LOBİDEN ÇIKAR - baştan başlasınlar
      const allPlayers = Array.from(lobby.values());
      
      // Tüm oyunculara iptal mesajı gönder
      allPlayers.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
          player.ws.send(JSON.stringify({
            type: 'MATCH_CANCELED',
            message: 'Not enough players confirmed. Please join lobby again.'
          }));
        }
      });
      
      // Lobiyi tamamen temizle
      console.log(`🧹 Clearing entire lobby. All players must rejoin.`);
      lobby.clear();
      lobbyState = 'idle';
      lobbyTimer = null;
      confirmationTimer = null;
    }
  }, 15000); // Onay süresini 15 saniyeye çıkardık
}


function createGameFromLobby(confirmedPlayers) {
  console.log(`🎮 Creating game with ${confirmedPlayers.length} players`);
  
  // Yeni oda oluştur
  const roomId = uuidv4();
  const room = new GameRoom(roomId);
  gameRooms.set(roomId, room);
  
  // Oyuncuları odaya ekle
  confirmedPlayers.forEach((player) => {
    const playerId = player.id;
    const playerDataWithWs = {
      ...player.playerData,
      ws: player.ws  // WebSocket referansını da ekle
    };
    const joined = room.addPlayer(playerId, playerDataWithWs);
    
    if (joined) {
      players.set(playerId, { ws: player.ws, roomId: room.id });
      
      // Oyuncuya oyuna katıldığını bildir
      player.ws.send(JSON.stringify({
        type: 'GAME_JOINED',
        playerId,
        roomId: room.id,
        gameState: room.getGameState()
      }));
    }
  });
  
  // Oyunu başlat
  room.startGame();
  
  // ✅ updateGameTimer() zaten 5 dakika sonra endMatch() çağıracak
  // Gereksiz setTimeout() kaldırıldı - çifte system sorunu çözüldü
  
  // Lobiyi temizle
  lobby.clear();
  lobbyTimer = null;
  
  console.log(`✅ Game ${roomId} started with ${confirmedPlayers.length} players`);
}

async function endMatch(room) {
  console.log(`🏁 Ending match in room ${room.id}`);
  
  // Create final leaderboard - SURVIVAL + KILL RANKING SYSTEM
  const survivors = Array.from(room.players.values()).filter(p => p.isAlive);
  const deadPlayers = Array.from(room.players.values()).filter(p => !p.isAlive);
  
  // Sort survivors by kills (descending), then dead players by kills
  const finalLeaderboard = [
    ...survivors.sort((a, b) => b.kills - a.kills),
    ...deadPlayers.sort((a, b) => b.kills - a.kills)
  ];
  
  console.log(`🏆 Final rankings:`, finalLeaderboard.map((p, i) => 
    `${i+1}. ${p.id} (${p.kills} kills, ${p.isAlive ? 'ALIVE' : 'DEAD'})`
  ));
  
  // Use the NEW SYSTEM: calculatePrizeDistribution
  const prizeDistribution = room.calculatePrizeDistribution(finalLeaderboard);
  
  console.log('💰 Prize Distribution Result:', prizeDistribution);
  
  // Convert to blockchain format
  const winners = prizeDistribution.map(p => p.walletAddress);
  const amounts = prizeDistribution.map(p => BigInt(Math.floor(p.prize * 1e18))); // Convert to wei
  
  // CRITICAL FIX: Non-blocking prize distribution
  if (winners.length > 0) {
    console.log('🔗 Starting prize distribution in background...');
    console.log('Winners:', winners);
    console.log('Amounts (S):', amounts.map(a => ethers.formatEther(a)));
    
    // Fire-and-forget: don't block game ending with blockchain calls
    setImmediate(() => {
      gameContract.distributePrizes(winners, amounts)
        .then(() => {
          console.log('✅ Prizes distributed to pending rewards successfully');
        })
        .catch((error) => {
          console.error('❌ Prize distribution failed:', error.message);
          console.log('⚠️ Prize distribution failed but game ended successfully');
        });
    });
  } else {
    console.log('⚠️ No winners found - no prize distribution');
  }
  
  // CRITICAL FIX: Use consistent broadcast method
  broadcastToRoom(room.id, {
    type: 'GAME_ENDED',
    gameState: room.getGameState(),
    players: Array.from(room.players.values()),
    finalLeaderboard: finalLeaderboard,
    prizePool: room.calculatePrizePool(),
    prizeDistribution: prizeDistribution,
    survivors: survivors.length
  });
  
  // Oyunu bitir - non-blocking
  room.endGame();
}

console.log('🐍 Sonic Snake GameFi Server Started!');
console.log('📋 Game Rules:');
console.log('   - Max players per room:', GAME_CONFIG.MAX_PLAYERS_PER_ROOM);
console.log('   - Game duration:', GAME_CONFIG.GAME_DURATION / 1000 / 60, 'minutes');