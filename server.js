const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 60000
});
app.use(express.static('public'));

const WORDS = {
  'Дом': ['телевизор', 'холодильник', 'диван', 'чайник', 'зеркало', 'шкаф'],
  'Еда': ['пицца', 'борщ', 'арбуз', 'шоколад', 'пельмени', 'мороженое'],
  'Места': ['аэропорт', 'библиотека', 'пляж', 'больница', 'цирк', 'вокзал'],
  'Профессии': ['врач', 'пилот', 'повар', 'учитель', 'пожарный', 'художник'],
  'Животные': ['слон', 'пингвин', 'лиса', 'дельфин', 'ёжик', 'верблюд']
};

// Сколько ждём игрока, который свернул браузер, прежде чем убрать его из комнаты
const GRACE_MS = 3 * 60 * 1000;

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

function checkAllVoted(room) {
  if (room.phase !== 'vote') return;
  const voters = room.players.length;
  if (Object.keys(room.votes).length < voters) return;
  const count = {};
  Object.values(room.votes).forEach(id => { count[id] = (count[id] || 0) + 1; });
  const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
  const caught = top === room.spyId;
  finish(room, caught ? 'Шпиона поймали!' : 'Шпион ушёл безнаказанным!', caught ? 'players' : 'spy');
}

// Окончательно убираем игрока из комнаты
function removePlayer(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;
  room.players = room.players.filter(p => p.id !== playerId);
  delete room.votes[playerId];
  io.to(room.code).emit('peer-left', playerId);
  if (room.players.length === 0) {
    clearTimeout(room.timer);
    delete rooms[room.code];
    return;
  }
  if (room.hostId === playerId) room.hostId = room.players[0].id;
  checkAllVoted(room);
  broadcast(room);
}

io.on('connection', (socket) => {
  let myRoom = null;

  function enter(room, player) {
    myRoom = room;
    socket.data.room = room;
    socket.join(room.code);
  }

  socket.on('create', ({ name }) => {
    const code = makeCode();
    const room = { code, hostId: socket.id, players: [], phase: 'lobby', votes: {} };
    room.players.push({ id: socket.id, name });
    rooms[code] = room;
    enter(room);
    broadcast(room);
  });

  socket.on('join', ({ code, name }) => {
    const room = rooms[code];
    if (!room) return socket.emit('error-msg', 'Комната не найдена');
    if (room.phase !== 'lobby') return socket.emit('error-msg', 'Игра уже идёт');
    room.players.push({ id: socket.id, name });
    enter(room);
    broadcast(room);
  });

  // Возвращение в комнату после сворачивания браузера
  socket.on('rejoin', ({ code, name, oldId }) => {
    const room = rooms[code];
    if (!room) return socket.emit('rejoin-failed');
    const player = room.players.find(p => p.id === oldId && p.name === name);
    if (!player) return socket.emit('rejoin-failed');

    clearTimeout(player.graceTimer);
    player.graceTimer = null;
    player.away = false;

    const newId = socket.id;
    if (room.hostId === oldId) room.hostId = newId;
    if (room.spyId === oldId) room.spyId = newId;
    if (room.votes[oldId] !== undefined) {
      room.votes[newId] = room.votes[oldId];
      delete room.votes[oldId];
    }
    Object.keys(room.votes).forEach(k => {
      if (room.votes[k] === oldId) room.votes[k] = newId;
    });
    player.id = newId;

    enter(room);
    io.to(room.code).emit('peer-left', oldId);
    socket.emit('rejoined', { code: room.code });
    broadcast(room);
    if (room.phase === 'play') {
      socket.emit('card', { text: newId === room.spyId ? 'ШПИОН' : room.word });
    }
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
    checkAllVoted(room);
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
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    // Не удаляем сразу: человек мог просто свернуть браузер
    player.away = true;
    const leavingId = socket.id;
    player.graceTimer = setTimeout(() => {
      const current = room.players.find(p => p.id === leavingId);
      if (current && current.away) removePlayer(room, leavingId);
    }, GRACE_MS);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Шпион запущен'));