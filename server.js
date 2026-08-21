// package.json: { "name": "wacky-workshops-io", "dependencies": { "express": "4.18", "socket.io": "4.6", "better-sqlite3": "9.0" } }

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const hrtime = require('process.hrtime');

const PORT = 3000;
const TICK_RATE = 50;
const WORLD_W = 3000;
const WORLD_H = 3000;
const MAX_ROOM = 10;
const BOT_COUNT = 5;
const SPEED = 4;
const ATTACK_RANGE = 60;
const ATTACK_DMG = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new Database('game.db');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE,
    level INTEGER DEFAULT 1,
    xp INTEGER DEFAULT 0,
    allTimeScore INTEGER DEFAULT 0,
    gamesPlayed INTEGER DEFAULT 0,
    createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    playerId INTEGER,
    score INTEGER,
    xp INTEGER,
    duration INTEGER,
    endedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playerId) REFERENCES players (id)
);
`);

// Prepared statements
const upsertPlayer = db.prepare(`
INSERT INTO players (username) VALUES (?) 
ON CONFLICT (username) DO UPDATE SET allTimeScore = allTimeScore + 1, gamesPlayed = gamesPlayed + 1;
`);

const insertSession = db.prepare(`
INSERT INTO sessions (playerId, score, xp, duration) VALUES (?, ?, ?, ?);
`);

const getTopPlayers = db.prepare(`
SELECT username, allTimeScore FROM players ORDER BY allTimeScore DESC LIMIT 10;
`);

class Player {
    constructor(id, username) {
        this.id = id;
        this.username = username;
        this.x = Math.random() * WORLD_W;
        this.y = Math.random() * WORLD_H;
        this.dx = 0;
        this.dy = 0;
        this.score = 0;
        this.level = 1;
        this.xp = 0;
    }
}

class Bot {
    constructor(id) {
        this.id = id;
        this.state = 'idle';
        this.x = Math.random() * WORLD_W;
        this.y = Math.random() * WORLD_H;
        this.targetPlayer = null;
    }

    update(players) {
        if (this.state === 'idle') {
            if (Math.random() < 0.1) this.state = 'wander';
        } else if (this.state === 'wander') {
            this.x += (Math.random() - 0.5) * SPEED;
            this.y += (Math.random() - 0.5) * SPEED;

            if (Math.random() < 0.02) this.state = 'chase';
        } else if (this.state === 'chase' && this.targetPlayer) {
            const dx = this.targetPlayer.x - this.x;
            const dy = this.targetPlayer.y - this.y;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (distance < ATTACK_RANGE) {
                this.state = 'attack';
                this.targetPlayer.score -= ATTACK_DMG;
            } else {
                this.x += (dx / distance) * SPEED;
                this.y += (dy / distance) * SPEED;
            }
        } else if (this.state === 'attack') {
            // Attack logic here
            this.state = 'idle'; // Resetting after attacking
        }
    }
}

class CollectibleManager {
    constructor() {
        this.collectibles = [];
    }

    spawnCollectibles(count) {
        // Logic to spawn collectibles
    }

    checkPickups(player) {
        // Logic to check if player picks up collectibles
    }
}

class Room {
    constructor(id) {
        this.id = id;
        this.players = new Map();
        this.bots = [];
        this.collectibleManager = new CollectibleManager();
        this.gameRunning = false;
        this.tickCount = 0;
    }

    addPlayer(player) {
        this.players.set(player.id, player);
    }

    removePlayer(playerId) {
        this.players.delete(playerId);
    }

    populateBots() {
        for (let i = 0; i < BOT_COUNT; i++) {
            this.bots.push(new Bot(i));
        }
    }

    startGameLoop() {
        const gameLoop = () => {
            this.gameLoop();
            setTimeout(gameLoop, 1000 / TICK_RATE);
        };
        gameLoop();
    }

    gameLoop() {
        this.bots.forEach(bot => bot.update(Array.from(this.players.values())));
        this.broadcastState();
        this.tickCount++;

        if (this.tickCount % 5 === 0) {
            io.to(this.id).emit('leaderboardUpdate', this.getLeaderboard());
        }
    }

    broadcastState() {
        const gameState = {
            players: Array.from(this.players.values()).map(p => ({ id: p.id, x: p.x, y: p.y, score: p.score })),
            bots: this.bots,
        };
        io.to(this.id).emit('gameState', gameState);
    }

    getLeaderboard() {
        return Array.from(this.players.values()).map(p => ({ playerId: p.id, score: p.score }));
    }
}

class RoomManager {
    constructor() {
        this.rooms = new Map();
    }

    findOrCreateRoom(roomId) {
        if (!this.rooms.has(roomId)) {
            const room = new Room(roomId);
            room.populateBots();
            this.rooms.set(roomId, room);
            room.startGameLoop();
        }
        return this.rooms.get(roomId);
    }

    destroyRoom(roomId) {
        setTimeout(() => {
            if (this.rooms.get(roomId).players.size === 0) {
                this.rooms.delete(roomId);
            }
        }, 30000);
    }
}

const roomManager = new RoomManager();

function savePlayerSession(playerId, score, xp) {
    const player = Array.from(roomManager.rooms.values()).flatMap(r => Array.from(r.players.values())).find(p => p.id === playerId);
    if (player) {
        insertSession.run(player.id, score, player.xp, 0); // Pass duration appropriately
    }
}

function loadPlayerProfile(username) {
    const player = upsertPlayer.run(username);
    return player.lastInsertRowid;
}

function getGlobalLeaderboard() {
    return getTopPlayers.all();
}

io.on('connection', (socket) => {
    console.log('New client connected');
    
    socket.on('joinRoom', (username, roomId) => {
        const playerId = loadPlayerProfile(username);
        const player = new Player(playerId, username);
        const room = roomManager.findOrCreateRoom(roomId);
        room.addPlayer(player);
        socket.currentRoomId = room.id;
        socket.currentPlayerId = socket.id;
        socket.join(room.id);
        socket.emit('roomJoined', room.id, Array.from(room.players.values()));
    });

    socket.on('playerInput', (input) => {
        const room = roomManager.rooms.get(socket.currentRoomId);
        if (!room) return;

        const player = room.players.get(socket.currentPlayerId);
        const { dx, dy } = input.action; 

        if (dx < -1 || dx > 1 || dy < -1 || dy > 1) {
            console.log('Invalid input');
            return;
        }

        player.dx = dx * SPEED;
        player.dy = dy * SPEED;
        player.x += player.dx;
        player.y += player.dy;
    });

    socket.on('respawn', () => {
        const room = roomManager.rooms.get(socket.currentRoomId);
        if (!room) return;

        const player = new Player(socket.currentPlayerId, 'Player'); // restore username if needed
        room.addPlayer(player);
    });

    socket.on('ping', () => {
        socket.emit('pong');
    });

    socket.on('requestLeaderboard', () => {
        const leaderboard = getGlobalLeaderboard();
        socket.emit('globalLeaderboard', leaderboard);
    });

    socket.on('disconnect', () => {
        const room = roomManager.rooms.get(socket.currentRoomId);
        if (!room) return;

        const playerId = socket.currentPlayerId;
        savePlayerSession(playerId, room.players.get(playerId).score, room.players.get(playerId).xp);
        room.removePlayer(playerId);
    });
});

app.use(express.static('public'));
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});