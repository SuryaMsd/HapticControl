const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Room state: roomCode -> { controller: socketId, receiver: socketId }
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

  // Controller creates a new room
  socket.on('create_room', (cb) => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    rooms.set(code, { controller: socket.id, receiver: null });
    socket.join(code);
    socket.roomCode = code;
    socket.role = 'controller';
    console.log(`[Room] Created: ${code} by ${socket.id}`);
    cb({ success: true, code });
  });

  // Receiver joins an existing room
  socket.on('join_room', (code, cb) => {
    const upperCode = code.toUpperCase();
    const room = rooms.get(upperCode);
    if (!room) return cb({ success: false, error: 'Room not found' });
    if (room.receiver) return cb({ success: false, error: 'Room already has a partner' });

    room.receiver = socket.id;
    socket.join(upperCode);
    socket.roomCode = upperCode;
    socket.role = 'receiver';

    // Notify controller that partner joined
    io.to(room.controller).emit('partner_joined');
    console.log(`[Room] ${socket.id} joined room: ${upperCode}`);
    cb({ success: true, code: upperCode });
  });

  // Relay: controller -> receiver (vibrate command)
  socket.on('vibrate', (payload) => {
    if (socket.role !== 'controller') return;
    const room = rooms.get(socket.roomCode);
    if (room?.receiver) {
      io.to(room.receiver).emit('vibrate', payload);
    }
  });

  // Relay: controller -> receiver (sound command)
  socket.on('play_sound', (payload) => {
    if (socket.role !== 'controller') return;
    const room = rooms.get(socket.roomCode);
    if (room?.receiver) {
      io.to(room.receiver).emit('play_sound', payload);
    }
  });

  // Relay: controller -> receiver (stop everything)
  socket.on('stop_all', () => {
    if (socket.role !== 'controller') return;
    const room = rooms.get(socket.roomCode);
    if (room?.receiver) {
      io.to(room.receiver).emit('stop_all');
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`[-] Disconnected: ${socket.id}`);
    const code = socket.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.role === 'controller') {
      if (room.receiver) io.to(room.receiver).emit('partner_left');
      rooms.delete(code);
      console.log(`[Room] Deleted: ${code}`);
    } else if (socket.role === 'receiver') {
      room.receiver = null;
      io.to(room.controller).emit('partner_left');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮 Haptic Control Server running at http://localhost:${PORT}\n`);
});
