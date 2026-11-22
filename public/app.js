const socket = io();
const $ = (id) => document.getElementById(id);

let state = null;
let myCard = null;
let timerInterval = null;
let localStream = null;
let micOn = true;
let inRoom = false;
const peers = {};
const pending = {};
const knownPlayers = new Set();
const talking = {};

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
    // Для надёжной связи добавьте свой TURN-сервер:
    // { urls: 'turn:ВАШ_СЕРВЕР:3478', username: 'user', credential: 'pass' }
  ]
};

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// ---------- Микрофон ----------
async function startMic() {
  if (localStream && localStream.getAudioTracks().some(t => t.readyState === 'live')) return true;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true }
    });
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    watchLevel('me', localStream);
    return true;
  } catch (e) {
    $('error').textContent = 'Нет доступа к микрофону. Разреши его в настройках браузера.';
    return false;
  }
}

// ---------- Лампочка говорящего ----------
let audioCtx = null;
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function watchLevel(key, stream) {
  try {
    const ctx = getCtx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let quietSince = 0;
    const check = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128));
      const loud = peak > 12;
      if (loud) quietSince = Date.now();
      const on = loud || Date.now() - quietSince < 400;
      if (key === 'me' && !micOn) talking[key] = false;
      else talking[key] = on;
      paintDots();
      if (key === 'me' || peers[key]) requestAnimationFrame(check);
    };
    check();
  } catch (e) {}
}

function paintDots() {
  document.querySelectorAll('.player[data-id]').forEach(el => {
    const id = el.getAttribute('data-id');
    const key = id === socket.id ? 'me' : id;
    const dot = el.querySelector('.dot');
    if (dot) dot.classList.toggle('talking', !!talking[key]);
  });
}

// ---------- Голосовой чат (WebRTC) ----------
function createPeer(id) {
  if (peers[id]) return peers[id];
  const pc = new RTCPeerConnection(ICE);
  peers[id] = pc;
  pending[id] = [];
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
      audio.playsInline = true;
      audio.setAttribute('playsinline', '');
      $('audioBox').appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.play().catch(() => showAudioHint());
    watchLevel(id, e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') dropPeer(id);
  };
  return pc;
}

function dropPeer(id) {
  if (peers[id]) { try { peers[id].close(); } catch (e) {} delete peers[id]; }
  delete pending[id];
  delete talking[id];
  const a = document.getElementById('audio-' + id);
  if (a) a.remove();
}

async function callPeer(id) {
  const pc = createPeer(id);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', { to: id, data: { sdp: pc.localDescription } });
}

socket.on('signal', async ({ from, data }) => {
  // Если соединение с этим игроком уже было и сломалось, начинаем заново
  if (data.sdp && data.sdp.type === 'offer' && peers[from] &&
      peers[from].signalingState !== 'stable') {
    dropPeer(from);
  }
  const pc = createPeer(from);
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    while (pending[from] && pending[from].length) {
      try { await pc.addIceCandidate(pending[from].shift()); } catch (e) {}
    }
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    if (pc.remoteDescription) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) {}
    } else {
      pending[from].push(data.candidate);
    }
  }
});

socket.on('peer-left', (id) => {
  dropPeer(id);
  knownPlayers.delete(id);
});

function toggleMic() {
  micOn = !micOn;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
  const label = micOn ? '🎤 Микрофон включён' : '🔇 Микрофон выключен';
  $('muteBtn').textContent = label;
  $('muteBtn2').textContent = label;
}

// Новый игрок звонит всем, кто уже был в комнате до него
function connectNewPeers() {
  if (!state || !localStream) return;
  const ids = state.players.map(p => p.id);
  const myIndex = ids.indexOf(socket.id);
  state.players.forEach((p, index) => {
    if (p.id === socket.id || knownPlayers.has(p.id)) return;
    knownPlayers.add(p.id);
    if (myIndex > index) callPeer(p.id);
  });
}

// ---------- Звук на iPhone ----------
// Safari не включает чужой звук, пока человек не коснулся экрана
function unlockAudio() {
  try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
  document.querySelectorAll('#audioBox audio').forEach(a => {
    a.play().then(hideAudioHint).catch(() => {});
  });
}
document.addEventListener('touchstart', unlockAudio);
document.addEventListener('click', unlockAudio);

function showAudioHint() {
  let hint = $('audioHint');
  if (!hint) {
    hint = document.createElement('div');
    hint.id = 'audioHint';
    hint.textContent = '🔈 Коснись экрана, чтобы включить звук';
    hint.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;padding:14px;' +
      'background:#d9475b;color:#fff;text-align:center;border-radius:12px;z-index:10;';
    document.body.appendChild(hint);
  }
}
function hideAudioHint() {
  const hint = $('audioHint');
  if (hint) hint.remove();
}

// ---------- Возвращение после сворачивания ----------
async function recoverVoice() {
  if (!inRoom || !state) return;
  await startMic();
  unlockAudio();
  // Пересоздаём соединения со всеми, чей звук перестал идти
  state.players.forEach((p, index) => {
    if (p.id === socket.id) return;
    const pc = peers[p.id];
    const bad = !pc || ['failed', 'disconnected', 'closed'].includes(pc.connectionState);
    if (!bad) return;
    dropPeer(p.id);
    knownPlayers.add(p.id);
    const myIndex = state.players.findIndex(x => x.id === socket.id);
    if (myIndex > index) callPeer(p.id);
  });
  // Подставляем свежий микрофон в уже работающие соединения
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    Object.values(peers).forEach(pc => {
      pc.getSenders().forEach(s => {
        if (s.track && s.track.kind === 'audio' && track) s.replaceTrack(track).catch(() => {});
      });
    });
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') setTimeout(recoverVoice, 300);
});
window.addEventListener('pageshow', () => setTimeout(recoverVoice, 300));

// ---------- Экраны ----------
function renderPlayers(boxId, onClick) {
  const box = $(boxId);
  box.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player';
    div.setAttribute('data-id', p.id);
    div.innerHTML = '<span class="dot"></span>' + p.name + (p.id === state.hostId ? ' 👑' : '');
    if (onClick && p.id !== socket.id) div.onclick = () => onClick(p.id);
    box.appendChild(div);
  });
  paintDots();
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
  inRoom = true;
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
  unlockAudio();
  const ok = await startMic();
  if (!ok) return;
  socket.emit('create', { name });
};

$('joinBtn').onclick = async () => {
  const name = $('nameInput').value.trim();
  const code = $('codeInput').value.trim();
  if (!name || !code) return ($('error').textContent = 'Введи имя и код');
  unlockAudio();
  const ok = await startMic();
  if (!ok) return;
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