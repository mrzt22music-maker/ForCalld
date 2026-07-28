// ==========================================================
// ForCall — звонок + перевод
// Сигнализация: Supabase Realtime broadcast (канал = username)
// Голос: WebRTC напрямую, TURN/STUN — Metered.ca
// Перевод: Web Speech (STT) -> MyMemory (translate) -> data channel
//          -> Web Speech (TTS) на стороне собеседника
// ==========================================================

const cfg = window.FORCALL_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const LANG_NAME_TO_CODE = { 'Қазақша': 'kk', 'Русский': 'ru', 'English': 'en', 'Tagalog': 'tl', 'Filipino': 'tl' };
const RECOGNITION_LOCALE = { kk: 'kk-KZ', ru: 'ru-RU', en: 'en-US', tl: 'fil-PH' };

const me = JSON.parse(localStorage.getItem('forcall_me') || 'null');
if (!me) {
  alert('Сначала зарегистрируйся');
  window.location.href = 'index.html';
}

const myLangCode = LANG_NAME_TO_CODE[me?.language] || 'en';
let myTargetLang = localStorage.getItem('forcall_target_lang') || 'en';

// --- DOM ---
const screenIdle = document.getElementById('screenIdle');
const screenCall = document.getElementById('screenCall');
const mePill = document.getElementById('mePill');
const targetIdInput = document.getElementById('targetId');
const callBtn = document.getElementById('callBtn');
const peerAvatar = document.getElementById('peerAvatar');
const peerName = document.getElementById('peerName');
const callStatus = document.getElementById('callStatus');
const captionBox = document.getElementById('captionBox');
const muteBtn = document.getElementById('muteBtn');
const hangupBtn = document.getElementById('hangupBtn');
const langChips = document.querySelectorAll('#langChips .chip');
const incomingModal = document.getElementById('incomingModal');
const incomingAvatar = document.getElementById('incomingAvatar');
const incomingName = document.getElementById('incomingName');
const acceptBtn = document.getElementById('acceptBtn');
const declineBtn = document.getElementById('declineBtn');

mePill.textContent = `Ты на связи: @${me.username}`;
langChips.forEach(chip => {
  if (chip.dataset.lang === myTargetLang) chip.classList.add('selected');
  chip.addEventListener('click', () => {
    langChips.forEach(c => c.classList.remove('selected'));
    chip.classList.add('selected');
    myTargetLang = chip.dataset.lang;
    localStorage.setItem('forcall_target_lang', myTargetLang);
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'lang', lang: myTargetLang }));
    }
  });
});

function showIdle() { screenIdle.classList.add('show'); screenCall.classList.remove('show'); }
function showCall() { screenCall.classList.add('show'); screenIdle.classList.remove('show'); }
showIdle();

// --- state ---
let pc = null;
let localStream = null;
let dataChannel = null;
let peerUsername = null;
let peerTargetLang = 'en'; // lang the PEER wants translations in (they tell us)
let audioCtx = null;
let gainNode = null;
let recognition = null;
let pendingOffer = null; // {from, fromNick, fromAvatar, sdp}
let incomingSignalChannel = null;

// --- Metered TURN credentials ---
async function getIceServers() {
  try {
    const res = await fetch(`https://${cfg.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${cfg.METERED_API_KEY}`);
    if (!res.ok) throw new Error('metered request failed');
    return await res.json();
  } catch (err) {
    console.warn('Не удалось получить TURN-креды Metered, используем публичный STUN', err);
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }
}

// --- Supabase signaling helpers ---
function channelFor(username) {
  return sb.channel(`signal:${username}`, { config: { broadcast: { self: false } } });
}

function sendSignal(toUsername, event, payload) {
  const ch = channelFor(toUsername);
  ch.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      ch.send({ type: 'broadcast', event, payload });
      setTimeout(() => sb.removeChannel(ch), 1500);
    }
  });
}

// listen for calls coming to ME, at all times
function listenForIncomingCalls() {
  incomingSignalChannel = channelFor(me.username);
  incomingSignalChannel
    .on('broadcast', { event: 'offer' }, ({ payload }) => onIncomingOffer(payload))
    .on('broadcast', { event: 'answer' }, ({ payload }) => onAnswer(payload))
    .on('broadcast', { event: 'ice' }, ({ payload }) => onRemoteIce(payload))
    .on('broadcast', { event: 'hangup' }, () => endCall(false))
    .subscribe();
}
listenForIncomingCalls();

// --- Build a peer connection (shared by caller/callee) ---
async function buildPeerConnection() {
  const iceServers = await getIceServers();
  pc = new RTCPeerConnection({ iceServers });

  pc.onicecandidate = (e) => {
    if (e.candidate && peerUsername) {
      sendSignal(peerUsername, 'ice', { candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => setupRemoteAudio(e.streams[0]);

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') callStatus.textContent = 'На связи';
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) endCall(false);
  };

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error('Нет доступа к микрофону — разреши доступ в браузере (' + err.message + ')');
  }
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
}

// --- Audio routing with ducking support ---
function setupRemoteAudio(stream) {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 1;
  source.connect(gainNode).connect(audioCtx.destination);
}

function duckAudio(durationMs) {
  if (!gainNode) return;
  const now = audioCtx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(0.25, now + 0.15);
  gainNode.gain.linearRampToValueAtTime(1, now + durationMs / 1000);
}

// --- Data channel (captions/translation) ---
function setupDataChannel(channel) {
  dataChannel = channel;
  dataChannel.onopen = () => {
    dataChannel.send(JSON.stringify({ type: 'lang', lang: myTargetLang }));
  };
  dataChannel.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'lang') peerTargetLang = msg.lang;
    if (msg.type === 'caption') {
      captionBox.innerHTML = `<b>${msg.text}</b>`;
      speakTranslation(msg.text, msg.lang);
    }
  };
}

function speakTranslation(text, lang) {
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = RECOGNITION_LOCALE[lang] || 'en-US';
  const estMs = Math.max(1500, text.length * 90);
  duckAudio(estMs);
  speechSynthesis.speak(utter);
}

// --- Speech recognition (my mic -> translate -> send) ---
function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    captionBox.textContent = 'Браузер не поддерживает распознавание речи (используй Chrome).';
    return;
  }
  recognition = new SR();
  recognition.lang = RECOGNITION_LOCALE[myLangCode] || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = async (e) => {
    const last = e.results[e.results.length - 1];
    if (!last.isFinal) return;
    const text = last[0].transcript.trim();
    if (!text) return;
    const translated = await translateText(text, myLangCode, peerTargetLang);
    if (dataChannel && dataChannel.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'caption', text: translated, lang: peerTargetLang }));
    }
  };

  recognition.onerror = (e) => console.warn('speech recognition error', e.error);
  recognition.onend = () => { if (pc && pc.connectionState !== 'closed') recognition.start(); }; // auto-restart
  recognition.start();
}

async function translateText(text, from, to) {
  if (from === to) return text;
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
    const data = await res.json();
    return data?.responseData?.translatedText || text;
  } catch (err) {
    console.warn('translate failed', err);
    return text;
  }
}

// --- Outgoing call ---
callBtn.addEventListener('click', async () => {
  const target = targetIdInput.value.trim().toLowerCase();
  if (!target) { alert('Введи ID собеседника'); return; }

  try {
    const { data: targetUser, error } = await sb.from('users').select('*').eq('username', target).maybeSingle();
    if (error) throw new Error('Supabase: ' + error.message);
    if (!targetUser) { alert('Пользователь @' + target + ' не найден'); return; }

    peerUsername = target;
    peerName.textContent = targetUser.nickname;
    peerAvatar.innerHTML = targetUser.avatar_url ? `<img src="${targetUser.avatar_url}">` : targetUser.nickname[0].toUpperCase();
    callStatus.textContent = 'Звоним...';
    showCall();

    await buildPeerConnection();
    const channel = pc.createDataChannel('captions');
    setupDataChannel(channel);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    sendSignal(target, 'offer', {
      from: me.username, fromNick: me.nickname, fromAvatar: me.avatarUrl, sdp: offer,
    });

    startRecognition();
  } catch (err) {
    console.error(err);
    alert('Не удалось позвонить: ' + err.message);
    endCall();
  }
});

// --- Incoming call ---
function onIncomingOffer(payload) {
  pendingOffer = payload;
  incomingName.textContent = payload.fromNick;
  incomingAvatar.innerHTML = payload.fromAvatar ? `<img src="${payload.fromAvatar}">` : payload.fromNick[0].toUpperCase();
  incomingModal.classList.add('show');
}

acceptBtn.addEventListener('click', async () => {
  incomingModal.classList.remove('show');
  const offerPayload = pendingOffer;
  peerUsername = offerPayload.from;
  peerName.textContent = offerPayload.fromNick;
  peerAvatar.innerHTML = offerPayload.fromAvatar ? `<img src="${offerPayload.fromAvatar}">` : offerPayload.fromNick[0].toUpperCase();
  callStatus.textContent = 'Соединяемся...';
  showCall();

  try {
    await buildPeerConnection();
    pc.ondatachannel = (e) => setupDataChannel(e.channel);

    await pc.setRemoteDescription(new RTCSessionDescription(offerPayload.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    sendSignal(peerUsername, 'answer', { from: me.username, sdp: answer });
    startRecognition();
  } catch (err) {
    console.error(err);
    alert('Не удалось принять звонок: ' + err.message);
    endCall();
  }
});

declineBtn.addEventListener('click', () => {
  incomingModal.classList.remove('show');
  if (pendingOffer) sendSignal(pendingOffer.from, 'hangup', {});
  pendingOffer = null;
});

async function onAnswer(payload) {
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
}

async function onRemoteIce(payload) {
  if (pc) {
    try { await pc.addIceCandidate(payload.candidate); }
    catch (err) { console.warn('ICE add failed', err); }
  }
}

// --- Controls ---
let muted = false;
muteBtn.addEventListener('click', () => {
  muted = !muted;
  localStream?.getAudioTracks().forEach(t => t.enabled = !muted);
  muteBtn.querySelector('.material-symbols-outlined').textContent = muted ? 'mic_off' : 'mic';
});

hangupBtn.addEventListener('click', () => {
  if (peerUsername) sendSignal(peerUsername, 'hangup', {});
  endCall(true);
});

function endCall() {
  recognition?.stop();
  speechSynthesis.cancel();
  localStream?.getTracks().forEach(t => t.stop());
  pc?.close();
  audioCtx?.close();
  pc = null; localStream = null; dataChannel = null; peerUsername = null; audioCtx = null; gainNode = null;
  captionBox.textContent = 'Перевод появится здесь во время разговора.';
  showIdle();
}
