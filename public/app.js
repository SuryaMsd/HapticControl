/* ═══════════════════════════════════════════
   HapticLink — App Logic
   ═══════════════════════════════════════════ */

const App = (() => {
  // ── State ──────────────────────────────────
  let socket = null;
  let role = null;           // 'controller' | 'receiver'
  let roomCode = null;
  let audioCtx = null;
  let audioUnlocked = false;
  let vibIntensity = 3;

  // ── Vibration patterns (ms arrays) ─────────
  const VIB_PATTERNS = {
    pulse:     [100, 80, 100, 80, 100],
    heartbeat: [60, 100, 200, 400, 60, 100, 200, 600],
    wave:      [80, 60, 120, 60, 160, 60, 200, 60, 160, 60, 120],
    sos:       [100,100,100, 200, 300,100,300,100,300, 200, 100,100,100],
    rapid:     [50,30,50,30,50,30,50,30,50,30,50,30,50],
    long:      [1200],
  };

  const INTENSITY_SCALE = [0.3, 0.55, 1, 1.4, 2.0];

  function scalePattern(pattern, intensityIdx) {
    const scale = INTENSITY_SCALE[intensityIdx - 1];
    return pattern.map(ms => Math.round(ms * scale));
  }

  // ── Audio synthesis ─────────────────────────
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function playTone(type, freq, duration, volume, attack = 0.01, decay = 0.1, sustain = 0.6, release = 0.3) {
    try {
      const ctx = getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.value = freq;
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(volume * sustain, now + attack);
      gain.gain.setValueAtTime(volume * sustain, now + attack + decay);
      gain.gain.linearRampToValueAtTime(0, now + duration + release);
      osc.start(now);
      osc.stop(now + duration + release + 0.05);
    } catch(e) { console.warn('Audio error:', e); }
  }

  const SOUNDS = {
    chime: (vol) => {
      [523, 659, 784, 1047].forEach((f, i) => {
        setTimeout(() => playTone('sine', f, 0.4, vol * 0.7, 0.01, 0.05, 0.7, 0.4), i * 120);
      });
    },
    alert: (vol) => {
      [880, 440, 880, 440].forEach((f, i) => {
        setTimeout(() => playTone('sawtooth', f, 0.15, vol * 0.5, 0.005, 0.05, 0.5, 0.1), i * 180);
      });
    },
    beep: (vol) => {
      [1000, 1000].forEach((f, i) => {
        setTimeout(() => playTone('square', f, 0.08, vol * 0.3, 0.005, 0.02, 0.4, 0.08), i * 150);
      });
    },
    love: (vol) => {
      [392, 494, 587, 740].forEach((f, i) => {
        setTimeout(() => playTone('sine', f, 0.5, vol * 0.6, 0.02, 0.1, 0.7, 0.5), i * 180);
      });
    },
    ping: (vol) => {
      playTone('sine', 1318, 0.3, vol * 0.6, 0.001, 0.01, 0.8, 0.6);
    },
    thunder: (vol) => {
      try {
        const ctx = getAudioCtx();
        const bufSize = ctx.sampleRate * 0.8;
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.15));
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const gain = ctx.createGain();
        gain.gain.value = vol * 2;
        src.connect(gain);
        gain.connect(ctx.destination);
        src.start();
      } catch(e) { console.warn(e); }
    },
    whistle: (vol) => {
      [784, 880, 988, 880, 784].forEach((f, i) => {
        setTimeout(() => playTone('sine', f, 0.18, vol * 0.5, 0.01, 0.05, 0.6, 0.2), i * 140);
      });
    },
    siren: (vol) => {
      try {
        const ctx = getAudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.3);
        osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.6);
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.9);
        gain.gain.setValueAtTime(vol * 0.4, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.0);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 1.05);
      } catch(e) { console.warn(e); }
    },
  };

  // ── Combos ─────────────────────────────────
  const COMBOS = {
    love:      { vibrate: 'heartbeat', sound: 'love' },
    attention: { vibrate: 'rapid',     sound: 'alert' },
    celebrate: { vibrate: 'wave',      sound: 'chime' },
  };

  // ── Screen navigation ───────────────────────
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById('screen-' + id).classList.add('active');
  }

  function goLanding() {
    if (socket) { socket.disconnect(); socket = null; }
    role = null; roomCode = null;
    showScreen('landing');
  }

  function goCreate() {
    showScreen('create');
    initSocket();
    socket.emit('create_room', (res) => {
      if (!res.success) return showToast('❌ Server error, retry');
      roomCode = res.code;
      displayCode(roomCode);
    });
  }

  function goJoin() {
    showScreen('join');
    initCodeInputs();
    if (!socket) initSocket();
  }

  function displayCode(code) {
    for (let i = 0; i < 6; i++) {
      const el = document.getElementById('c' + i);
      if (el) {
        el.textContent = '—';
        setTimeout(() => {
          el.textContent = code[i];
          el.style.transform = 'scale(1.3)';
          setTimeout(() => el.style.transform = '', 250);
        }, i * 80);
      }
    }
  }

  function copyCode() {
    if (!roomCode) return;
    navigator.clipboard.writeText(roomCode).then(() => showToast('✅ Code copied!')).catch(() => {
      showToast('Code: ' + roomCode);
    });
  }

  // ── Code input auto-advance ─────────────────
  function initCodeInputs() {
    for (let i = 0; i < 6; i++) {
      const inp = document.getElementById('ci-' + i);
      if (!inp) continue;
      inp.value = '';
      inp.oninput = () => {
        const v = inp.value.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
        inp.value = v ? v[0] : '';
        if (v && i < 5) document.getElementById('ci-' + (i+1)).focus();
      };
      inp.onkeydown = (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0)
          document.getElementById('ci-' + (i-1)).focus();
        if (e.key === 'Enter') submitJoin();
      };
      inp.onfocus = () => inp.select();
    }
    setTimeout(() => document.getElementById('ci-0')?.focus(), 100);
  }

  function getEnteredCode() {
    return Array.from({length:6}, (_, i) => document.getElementById('ci-'+i)?.value || '').join('');
  }

  function submitJoin() {
    const code = getEnteredCode();
    if (code.length < 6) return setJoinError('Please enter all 6 characters');
    clearJoinError();
    if (!socket) initSocket();
    socket.emit('join_room', code, (res) => {
      if (!res.success) return setJoinError(res.error || 'Failed to join');
      roomCode = res.code;
      role = 'receiver';
      showScreen('receiver');
    });
  }

  function setJoinError(msg) {
    const el = document.getElementById('join-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }
  function clearJoinError() {
    document.getElementById('join-error')?.classList.add('hidden');
  }

  // ── Socket.io ───────────────────────────────
  function initSocket() {
    if (socket) return;
    socket = io({ transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      console.log('Socket connected:', socket.id);
    });

    socket.on('partner_joined', () => {
      role = 'controller';
      showScreen('controller');
      showToast('🎉 Partner connected!');
    });

    socket.on('partner_left', () => {
      showToast('⚠️ Partner disconnected');
      setTimeout(goLanding, 1500);
    });

    socket.on('vibrate', (payload) => {
      if (role !== 'receiver') return;
      doVibrate(payload);
      addLog('vib', '📳 Vibration — ' + payload.pattern + ' (×' + payload.intensity + ')');
      activateReceiverRing();
    });

    socket.on('play_sound', (payload) => {
      if (role !== 'receiver') return;
      doPlaySound(payload);
      addLog('snd', '🔊 Sound — ' + payload.sound);
      activateReceiverRing();
    });

    socket.on('stop_all', () => {
      if (navigator.vibrate) navigator.vibrate(0);
      document.getElementById('receiver-status').textContent = 'Signal stopped.';
      setTimeout(() => {
        document.getElementById('receiver-status').textContent = 'Waiting for signal…';
      }, 2000);
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });
  }

  // ── Vibration (on receiver) ─────────────────
  function doVibrate(payload) {
    if (!('vibrate' in navigator)) return;
    const base = VIB_PATTERNS[payload.pattern] || VIB_PATTERNS.pulse;
    const scaled = scalePattern(base, payload.intensity);
    navigator.vibrate(scaled);
    document.getElementById('receiver-status').textContent = `Feeling: ${payload.pattern}…`;
    setTimeout(() => {
      document.getElementById('receiver-status').textContent = 'Waiting for signal…';
    }, scaled.reduce((a,b)=>a+b,0) + 500);
  }

  // ── Sound (on receiver) ─────────────────────
  function doPlaySound(payload) {
    const fn = SOUNDS[payload.sound];
    if (fn) fn(payload.volume ?? 0.7);
    document.getElementById('receiver-status').textContent = `Playing: ${payload.sound}…`;
    setTimeout(() => {
      document.getElementById('receiver-status').textContent = 'Waiting for signal…';
    }, 2000);
  }

  function activateReceiverRing() {
    const ring = document.getElementById('receiver-ring');
    ring.classList.add('active');
    setTimeout(() => ring.classList.remove('active'), 1200);
  }

  function addLog(type, msg) {
    const log = document.getElementById('receiver-log');
    const hint = log.querySelector('.hint');
    if (hint) hint.remove();
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0') + ':' + now.getSeconds().toString().padStart(2,'0');
    const div = document.createElement('div');
    div.className = 'log-item ' + type;
    div.innerHTML = `<span>${msg}</span><span class="log-time">${time}</span>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    // Keep only last 20 logs
    while (log.children.length > 20) log.removeChild(log.firstChild);
  }

  // ── Controller actions ──────────────────────
  function updateIntensityLabel(val) {
    vibIntensity = parseInt(val);
  }

  function sendVibrate(pattern) {
    if (!socket) return;
    const payload = { pattern, intensity: vibIntensity };
    socket.emit('vibrate', payload);
    flashBtn('pat-' + pattern);
    showToast('📳 Sent ' + pattern + ' vibration');
  }

  function sendSound(soundName) {
    if (!socket) return;
    const vol = (document.getElementById('snd-volume')?.value ?? 70) / 100;
    const payload = { sound: soundName, volume: vol };
    socket.emit('play_sound', payload);
    showToast('🔊 Sent ' + soundName + ' sound');
  }

  function sendCombo(comboName) {
    if (!socket) return;
    const combo = COMBOS[comboName];
    if (!combo) return;
    const vol = (document.getElementById('snd-volume')?.value ?? 70) / 100;
    socket.emit('vibrate', { pattern: combo.vibrate, intensity: vibIntensity });
    socket.emit('play_sound', { sound: combo.sound, volume: vol });
    showToast('🎉 Sent ' + comboName + ' combo!');
  }

  function stopAll() {
    if (!socket) return;
    socket.emit('stop_all');
    showToast('⏹ Stopped all signals');
  }

  function disconnect() {
    goLanding();
  }

  // ── Tabs ─────────────────────────────────────
  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    document.getElementById('panel-' + tab).classList.add('active');
  }

  // ── Audio unlock ─────────────────────────────
  function unlockAudio() {
    try {
      getAudioCtx();
      audioUnlocked = true;
      const btn = document.getElementById('btn-unlock-audio');
      if (btn) {
        btn.textContent = '✅ Sound enabled';
        btn.disabled = true;
        btn.style.opacity = '0.5';
      }
      showToast('🔊 Audio enabled!');
    } catch(e) { showToast('Audio unlock failed'); }
  }

  // ── UI helpers ────────────────────────────────
  function flashBtn(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('firing');
    setTimeout(() => el.classList.remove('firing'), 500);
  }

  let toastTimer = null;
  function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  // ── Public API ─────────────────────────────────
  return {
    goLanding, goCreate, goJoin, copyCode,
    submitJoin, switchTab, updateIntensityLabel,
    sendVibrate, sendSound, sendCombo, stopAll,
    disconnect, unlockAudio,
  };
})();
