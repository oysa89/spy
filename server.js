const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public'));

const WORDS = {
  'Дом': ['телевизор', 'холодильник', 'диван', 'чайник', 'зеркало', 'шкаф'],
  'Еда': ['пицца', 'борщ', 'арбуз', 'шоколад', 'пельмени', 'мороженое'],
  'Места': ['аэропорт', 'библиотека', 'пляж', 'больница', 'цирк', 'вокзал'],
  'Профессии': ['врач', 'пилот', 'повар', 'учитель', 'пожарный', 'художник'],
  'Животные': ['слон', 'пингвин', 'лиса', 'дельфин', 'ёжик', 'верблюд']
};

const rooms = {};

function makeCode() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms[code]);
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    phase: room.phase,
    hostId: room.hostId,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    endsAt: room.endsAt || null
  };
}

function broadcast(room) {
  io.to(room.code).emit('state', publicState(room));
}

function finish(room, text, winner) {
  clearTimeout(room.timer);
  room.phase = 'result';
  const spy = room.players.find(p => p.id === room.spyId);
  io.to(room.code).emit('result', {
    text, winner, word: room.word, spyName: spy ? spy.name : '?'
  });
  broadcast(room);
}

io.on('connection', (socket) => {
  let myRoom = null;

  socket.on('create', ({ name }) => {
    const code = makeCode();
    const room = { code, hostId: socket.id, players: [], phase: 'lobby', votes: {} };
    room.players.push({ id: socket.id, name });
    rooms[code] = room;
    myRoom = room;
    socket.join(code);
    broadcast(room);
  });

  socket.on('join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error-msg', 'Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('error-msg', 'Игра уже идёт');
    room.players.push({ id: socket.id, name });
    myRoom = room;
    socket.join(code);
    broadcast(room);
  });

  socket.on('start', ({ topic, minutes }) => {
    const room = myRoom;
    if (!room || room.hostId !== socket.id || room.players.length < 3) return;
    const list = WORDS[topic] || WORDS['Дом'];
    room.word = list[Math.floor(Math.random() * list.length)];
    room.spyId = room.players[Math.floor(Math.random() * room.players.length)].id;
    room.phase = 'play';
    room.votes = {};
    room.endsAt = Date.now() + (minutes || 8) * 60000;
    room.players.forEach(p => {
      io.to(p.id).emit('card', { text: p.id === room.spyId ? 'ШПИОН' : room.word });
    });
    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      room.phase = 'vote';
      broadcast(room);
    }, (minutes || 8) * 60000);
    broadcast(room);
  });

  socket.on('spy-guess', ({ guess }) => {
    const room = myRoom;
    if (!room || room.phase !== 'play' || socket.id !== room.spyId) return;
    const ok = String(guess).trim().toLowerCase() === room.word.toLowerCase();
    finish(room, ok ? 'Шпион угадал слово!' : 'Шпион ошибся!', ok ? 'spy' : 'players');
  });

  socket.on('vote', ({ targetId }) => {
    const room = myRoom;
    if (!room || room.phase !== 'vote') return;
    room.votes[socket.id] = targetId;
    if (Object.keys(room.votes).length < room.players.length) return;
    const count = {};
    Object.values(room.votes).forEach(id => { count[id] = (count[id] || 0) + 1; });
    const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    const caught = top === room.spyId;
    finish(room, caught ? 'Шпиона поймали!' : 'Шпион ушёл безнаказанным!', caught ? 'players' : 'spy');
  });

  socket.on('new-game', () => {
    const room = myRoom;
    if (!room || room.hostId !== socket.id) return;
    room.phase = 'lobby';
    broadcast(room);
  });

  // Сигнализация WebRTC: сервер только пересылает сообщения между игроками
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    const room = myRoom;
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(room.code).emit('peer-left', socket.id);
    if (room.players.length === 0) { clearTimeout(room.timer); delete rooms[room.code]; return; }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    broadcast(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Шпион запущен'));