const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let myCard = null;
let timerInterval = null;
let localStream = null;
let micOn = true;
const peers = {};

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
    // Для надёжной связи добавьте свой TURN-сервер:
    // { urls: 'turn:ВАШ_СЕРВЕР:3478', username: 'user', credential: 'pass' }
  ]
};

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- Голосовой чат (WebRTC) ----------
async function startMic() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    $('error').textContent = 'Нет доступа к микрофону';
  }
}

function createPeer(id) {
  const pc = new RTCPeerConnection(ICE);
  peers[id] = pc;
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + id);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + id;
      audio.autoplay = true;
      $('audioBox').appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };
  return pc;
}

async function callPeer(id) {
  const pc = peers[id] || createPeer(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
}

socket.on('signal', async ({ from, data }) => {
  const pc = peers[from] || createPeer(from);
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data.candidate); } catch (e) {}
  }
});

socket.on('peer-left', (id) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  const a = document.getElementById('audio-' + id);
  if (a) a.remove();
});

function toggleMic() {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const label = micOn ? '🎤 Микрофон включён' : '🔇 Микрофон выключен';
  $('muteBtn').textContent = label;
  $('muteBtn2').textContent = label;
}

// Новый игрок звонит всем, кто уже в комнате
let knownPlayers = new Set();
function connectNewPeers() {
  if (!state) return;
  state.players.forEach(p => {
    if (p.id !== socket.id && !knownPlayers.has(p.id)) {
      knownPlayers.add(p.id);
      // Звонит тот, чей id по алфавиту меньше, чтобы не было двойных звонков
      if (socket.id < p.id) callPeer(p.id);
    }
  });
}

// ---------- Экраны ----------
function renderPlayers(boxId, onClick) {
  const box = $(boxId);
  box.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = '<span class="dot"></span>' + p.name + (p.id === state.hostId ? ' 👑' : '');
    if (onClick && p.id !== socket.id) div.onclick = () => onClick(p.id);
    box.appendChild(div);
  });
}

function tick() {
  if (!state || !state.endsAt) return;
  const left = Math.max(0, Math.floor((state.endsAt - Date.now()) / 1000));
  const m = Math.floor(left / 60);
  const s = String(left % 60).padStart(2, '0');
  $('timer').textContent = m + ':' + s;
}

socket.on('state', (s) => {
  state = s;
  connectNewPeers();
  if (s.phase === 'lobby') {
    show('lobby');
    $('lobbyCode').textContent = s.code;
    $('hostControls').style.display = s.hostId === socket.id ? 'block' : 'none';
    $('startBtn').disabled = s.players.length < 3;
    renderPlayers('lobbyPlayers');
  } else if (s.phase === 'play') {
    show('play');
    renderPlayers('playPlayers');
    clearInterval(timerInterval);
    timerInterval = setInterval(tick, 500);
    tick();
  } else if (s.phase === 'vote') {
    clearInterval(timerInterval);
    show('vote');
    renderPlayers('votePlayers', (id) => {
      socket.emit('vote', { targetId: id });
      $('votePlayers').innerHTML = '<div class="sub">Голос принят, ждём остальных…</div>';
    });
  }
});

socket.on('card', ({ text }) => {
  myCard = text;
  const card = $('card');
  card.textContent = 'Нажми и держи, чтобы увидеть';
  card.className = 'card hidden';
  $('guessBtn').style.display = text === 'ШПИОН' ? 'block' : 'none';
});

socket.on('result', ({ text, winner, word, spyName }) => {
  clearInterval(timerInterval);
  show('result');
  $('resultText').innerHTML = text + '<br><br>Шпион: <b>' + spyName + '</b><br>Слово: <b>' + word + '</b>';
  $('newGameBtn').style.display = state && state.hostId === socket.id ? 'block' : 'none';
});

socket.on('error-msg', (msg) => { $('error').textContent = msg; });

// ---------- Кнопки ----------
const reveal = () => { $('card').textContent = myCard; $('card').className = 'card'; };
const hide = () => { $('card').textContent = 'Нажми и держи, чтобы увидеть'; $('card').className = 'card hidden'; };
$('card').addEventListener('touchstart', (e) => { e.preventDefault(); reveal(); });
$('card').addEventListener('touchend', hide);
$('card').addEventListener('mousedown', reveal);
$('card').addEventListener('mouseup', hide);
$('card').addEventListener('mouseleave', hide);

$('createBtn').onclick = async () => {
  const name = $('nameInput').value.trim();
  if (!name) return ($('error').textContent = 'Введи имя');
  await startMic();
  socket.emit('create', { name });
};

$('joinBtn').onclick = async () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim();
  if (!name || !code) return ($('error').textContent = 'Введи имя и код');
  await startMic();
  socket.emit('join', { code, name });
};

$('startBtn').onclick = () => {
  socket.emit('start', { topic: $('topicSelect').value, minutes: Number($('minutesSelect').value) });
};

$('guessBtn').onclick = () => {
  const guess = prompt('Какое слово у остальных?');
  if (guess) socket.emit('spy-guess', { guess });
};

$('newGameBtn').onclick = () => socket.emit('new-game');
$('muteBtn').onclick = toggleMic;
$('muteBtn2').onclick = toggleMic;