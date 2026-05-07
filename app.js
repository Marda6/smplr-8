'use strict';

/* ── Viewport height fix ──────────────────────────────────────────────────── */
function setAppHeight() {
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
}
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 150));
setAppHeight();

/* ── Note data ────────────────────────────────────────────────────────────── */
const NOTE_NAMES  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const WHITE_SEMI  = [0, 2, 4, 5, 7, 9, 11]; // semitone offsets per octave (white keys)
const BLACK_SEMI  = [1, 3, 6, 8, 10];        // semitone offsets per octave (black keys)
// After which white-key index (0-based, across full 2-octave keyboard) does each black key sit?
// Octave 1: C(0) D(1) E(2) F(3) G(4) A(5) B(6)  → black after 0,1,3,4,5
// Octave 2: C(7) D(8) E(9) F(10) G(11) A(12) B(13) → black after 7,8,10,11,12
const BLACK_AFTER_WHITE = [0, 1, 3, 4, 5,  7, 8, 10, 11, 12];
const BASE_MIDI = 48; // C3

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function midiToName(midi) {
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[midi % 12] + oct;
}

/* ── App state ────────────────────────────────────────────────────────────── */
const AppState = {
  waveform:    'sine',
  octaveShift: 0,   // -2 … +2
};

/* ── Audio engine ─────────────────────────────────────────────────────────── */
const AudioEngine = {
  ctx:       null,
  masterGain: null,
  analyser:   null,
  lfo:        null,
  lfoGain:    null,

  getCtx() {
    if (!this.ctx) this._init();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  _init() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;

    /* compressor → destination */
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 6;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.12;
    comp.connect(ctx.destination);

    /* analyser → compressor */
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(comp);
    this.analyser = analyser;

    /* masterGain → analyser */
    const mg = ctx.createGain();
    mg.gain.value = 0.65;
    mg.connect(analyser);
    this.masterGain = mg;

    /* LFO for vibrato (always running, depth controls mix) */
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 5.5; // Hz
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0;
    lfo.connect(lfoGain);
    lfo.start();
    this.lfo = lfo;
    this.lfoGain = lfoGain;
  },

  setVibratoDepth(depth /* 0-1 */) {
    if (!this.ctx) return;
    // At depth=1 → ~55 Hz modulation depth (roughly a semitone at middle C area)
    this.lfoGain.gain.setTargetAtTime(depth * 55, this.ctx.currentTime, 0.06);
  },

  createVoice(baseMidi) {
    const ctx = this.getCtx();
    const midi  = baseMidi + AppState.octaveShift * 12;
    const freq  = midiToFreq(Math.max(21, Math.min(108, midi)));

    const osc = ctx.createOscillator();
    osc.type = AppState.waveform;
    osc.frequency.value = freq;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0, ctx.currentTime);
    env.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 0.008); // attack 8 ms

    osc.connect(env);
    env.connect(this.masterGain);
    this.lfoGain.connect(osc.frequency); // vibrato
    osc.start();

    return { osc, env, midi };
  },

  releaseVoice(voice) {
    if (!voice || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    voice.env.gain.cancelScheduledValues(now);
    voice.env.gain.setValueAtTime(voice.env.gain.value, now);
    voice.env.gain.linearRampToValueAtTime(0, now + 0.22); // release 220 ms
    voice.osc.stop(now + 0.25);
    // Clean up LFO connection after oscillator ends
    voice.osc.onended = () => {
      try { this.lfoGain.disconnect(voice.osc.frequency); } catch (_) {}
    };
  },
};

/* ── Vibrato wheel ────────────────────────────────────────────────────────── */
const WheelUI = {
  canvas:   null,
  valueEl:  null,
  depth:    0,      // 0-1, vibrato depth
  _rot:     0,      // visual rotation offset (px, scrolls with drag)
  _dragging: false,
  _lastY:   0,

  init() {
    this.canvas  = document.getElementById('vibrato-wheel');
    this.valueEl = document.getElementById('wheel-value');
    // Size canvas after first paint
    requestAnimationFrame(() => {
      this._syncSize();
      this._draw();
    });
    this._bindEvents();
    window.addEventListener('resize', () => { this._syncSize(); this._draw(); });
  },

  _syncSize() {
    const w = this.canvas.parentElement.clientWidth  - 10; // panel padding
    const h = this.canvas.clientHeight || this.canvas.parentElement.clientHeight - 40;
    this.canvas.width  = Math.round(w * devicePixelRatio);
    this.canvas.height = Math.round(h * devicePixelRatio);
    this.canvas.style.width  = w + 'px';
    this.canvas.style.height = h + 'px';
  },

  _bindEvents() {
    const el = this.canvas;

    el.addEventListener('touchstart', e => {
      e.preventDefault();
      AudioEngine.getCtx();
      this._dragging = true;
      this._lastY = e.touches[0].clientY;
    }, { passive: false });

    el.addEventListener('touchmove', e => {
      e.preventDefault();
      if (!this._dragging) return;
      this._move(e.touches[0].clientY);
    }, { passive: false });

    el.addEventListener('touchend',   e => { e.preventDefault(); this._dragging = false; }, { passive: false });
    el.addEventListener('touchcancel', e => { e.preventDefault(); this._dragging = false; }, { passive: false });

    /* mouse fallback for desktop testing */
    el.addEventListener('mousedown', e => { AudioEngine.getCtx(); this._dragging = true; this._lastY = e.clientY; });
    window.addEventListener('mousemove', e => { if (this._dragging) this._move(e.clientY); });
    window.addEventListener('mouseup',   () => { this._dragging = false; });
  },

  _move(clientY) {
    const dy = clientY - this._lastY;
    this._lastY = clientY;
    // drag down = more vibrato
    this.depth = Math.max(0, Math.min(1, this.depth + dy / (this.canvas.clientHeight || 160) * 2));
    this._rot  = (this._rot + dy * 1.4) % 1000;
    AudioEngine.setVibratoDepth(this.depth);
    this.valueEl.textContent = Math.round(this.depth * 100) + '%';
    this._draw();
  },

  _draw() {
    const canvas = this.canvas;
    if (!canvas.width || !canvas.height) return;
    const c  = canvas.getContext('2d');
    const W  = canvas.width;
    const H  = canvas.height;
    const cx = W / 2;
    const dpr = devicePixelRatio;

    // Cap ellipse height (flat top/bottom edges of cylinder)
    const capH = Math.max(H * 0.06, 6 * dpr);

    c.clearRect(0, 0, W, H);

    /* ── Cylinder body gradient ── */
    const bodyGrad = c.createLinearGradient(0, 0, W, 0);
    bodyGrad.addColorStop(0,    '#0e0e0e');
    bodyGrad.addColorStop(0.1,  '#1c1c1c');
    bodyGrad.addColorStop(0.35, '#2a2a2a');
    bodyGrad.addColorStop(0.5,  '#323232');
    bodyGrad.addColorStop(0.65, '#2a2a2a');
    bodyGrad.addColorStop(0.9,  '#1c1c1c');
    bodyGrad.addColorStop(1,    '#0e0e0e');
    c.fillStyle = bodyGrad;
    c.fillRect(0, capH, W, H - capH * 2);

    /* ── Scrolling ridges (clip to body area) ── */
    const bodyH = H - capH * 2;
    const numRidges = 18;
    const ridgeSpacing = bodyH / numRidges;
    // _rot is a pixel offset that scrolls ridges
    const offset = ((this._rot % ridgeSpacing) + ridgeSpacing) % ridgeSpacing;

    c.save();
    c.beginPath();
    c.rect(0, capH, W, bodyH);
    c.clip();

    for (let i = -1; i <= numRidges + 1; i++) {
      const y = capH + i * ridgeSpacing + offset;

      // Groove shadow (darker line)
      c.strokeStyle = '#0a0a0a';
      c.lineWidth = 2 * dpr;
      c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke();

      // Ridge highlight (lighter line just above)
      c.strokeStyle = '#3c3c3c';
      c.lineWidth = 1 * dpr;
      c.beginPath(); c.moveTo(0, y - 2 * dpr); c.lineTo(W, y - 2 * dpr); c.stroke();
    }

    // Orange accent marks every 5th ridge
    for (let i = -1; i <= numRidges + 1; i++) {
      if (((i + 100) % 5) !== 0) continue;
      const y = capH + i * ridgeSpacing + offset - ridgeSpacing * 0.5;
      c.strokeStyle = '#e8632a';
      c.lineWidth = 2 * dpr;
      c.beginPath();
      c.moveTo(cx - 10 * dpr, y);
      c.lineTo(cx + 10 * dpr, y);
      c.stroke();
    }

    c.restore();

    /* ── 3-D shading overlay (cylinder curvature) ── */
    const shadeGrad = c.createLinearGradient(0, 0, W, 0);
    shadeGrad.addColorStop(0,    'rgba(0,0,0,0.62)');
    shadeGrad.addColorStop(0.14, 'rgba(0,0,0,0.18)');
    shadeGrad.addColorStop(0.42, 'rgba(255,255,255,0.03)');
    shadeGrad.addColorStop(0.50, 'rgba(255,255,255,0.11)');
    shadeGrad.addColorStop(0.58, 'rgba(255,255,255,0.03)');
    shadeGrad.addColorStop(0.86, 'rgba(0,0,0,0.18)');
    shadeGrad.addColorStop(1,    'rgba(0,0,0,0.62)');
    c.fillStyle = shadeGrad;
    c.fillRect(0, capH, W, bodyH);

    /* ── Top cap ellipse ── */
    const topGrad = c.createLinearGradient(0, 0, W, 0);
    topGrad.addColorStop(0,   '#0e0e0e');
    topGrad.addColorStop(0.5, '#2c2c2c');
    topGrad.addColorStop(1,   '#0e0e0e');
    c.fillStyle = topGrad;
    c.beginPath();
    c.ellipse(cx, capH, cx, capH, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#444';
    c.lineWidth = 1 * dpr;
    c.stroke();

    /* ── Bottom cap ellipse ── */
    const botGrad = c.createLinearGradient(0, 0, W, 0);
    botGrad.addColorStop(0,   '#080808');
    botGrad.addColorStop(0.5, '#1e1e1e');
    botGrad.addColorStop(1,   '#080808');
    c.fillStyle = botGrad;
    c.beginPath();
    c.ellipse(cx, H - capH, cx, capH, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#2a2a2a';
    c.lineWidth = 1 * dpr;
    c.stroke();

    /* ── Depth indicator arrow on right edge ── */
    const indY = capH + bodyH * (1 - this.depth);
    c.fillStyle = '#e8632a';
    c.beginPath();
    c.moveTo(W - 5 * dpr, indY - 4 * dpr);
    c.lineTo(W,            indY);
    c.lineTo(W - 5 * dpr, indY + 4 * dpr);
    c.closePath();
    c.fill();
  },
};

/* ── Piano keyboard ───────────────────────────────────────────────────────── */
const KeyboardUI = {
  container:    null,
  activeTouches: new Map(), // touchId → key element

  init() {
    this.container = document.getElementById('keyboard');
    this._build();
    this._bindTouch();
    this._bindMouse();
    window.addEventListener('resize', () => setTimeout(() => this._positionBlacks(), 50));
    window.addEventListener('orientationchange', () => setTimeout(() => this._positionBlacks(), 200));
  },

  _build() {
    const whiteWrap = document.getElementById('white-keys');
    const blackWrap = document.getElementById('black-keys');

    // Two full octaves (C3–B4) = 14 white + 1 top C5
    for (let oct = 0; oct < 2; oct++) {
      const base = BASE_MIDI + oct * 12;
      WHITE_SEMI.forEach(s => {
        const midi = base + s;
        const el = document.createElement('div');
        el.className = 'key white-key';
        el.dataset.midi = midi;
        if (s === 0) {
          const lbl = document.createElement('span');
          lbl.className = 'key-label';
          lbl.textContent = 'C' + (Math.floor(midi / 12) - 1);
          el.appendChild(lbl);
        }
        whiteWrap.appendChild(el);
      });
    }
    // Top C5
    const topC = document.createElement('div');
    topC.className = 'key white-key';
    topC.dataset.midi = BASE_MIDI + 24;
    const topLbl = document.createElement('span');
    topLbl.className = 'key-label';
    topLbl.textContent = 'C5';
    topC.appendChild(topLbl);
    whiteWrap.appendChild(topC);

    // Black keys: 5 per octave × 2 octaves = 10
    for (let oct = 0; oct < 2; oct++) {
      const base = BASE_MIDI + oct * 12;
      BLACK_SEMI.forEach(s => {
        const el = document.createElement('div');
        el.className = 'key black-key';
        el.dataset.midi = base + s;
        blackWrap.appendChild(el);
      });
    }

    requestAnimationFrame(() => this._positionBlacks());
  },

  _positionBlacks() {
    const whites = Array.from(this.container.querySelectorAll('.white-key'));
    const blacks = Array.from(this.container.querySelectorAll('.black-key'));
    if (!whites.length || !whites[0].offsetWidth) return;

    const kh = this.container.offsetHeight;
    const bw = whites[0].offsetWidth * 0.62;
    const bh = kh * 0.62;

    blacks.forEach((el, i) => {
      const wIdx = BLACK_AFTER_WHITE[i];
      // Place black key centred on the seam between white[wIdx] and white[wIdx+1]
      const x = whites[wIdx].offsetLeft + whites[wIdx].offsetWidth - bw * 0.5;
      el.style.left   = x + 'px';
      el.style.width  = bw + 'px';
      el.style.height = bh + 'px';
    });
  },

  _startNote(el) {
    if (!el || el.classList.contains('active')) return;
    el.classList.add('active');
    if (el._voice) AudioEngine.releaseVoice(el._voice);
    const midi = parseInt(el.dataset.midi);
    el._voice = AudioEngine.createVoice(midi);
    UIController.showNote(midiToName(midi + AppState.octaveShift * 12));
  },

  _stopNote(el) {
    if (!el || !el.classList.contains('active')) return;
    el.classList.remove('active');
    AudioEngine.releaseVoice(el._voice);
    el._voice = null;
  },

  _keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    if (el.classList.contains('key')) return el;
    return el.closest?.('.key') || null;
  },

  _bindTouch() {
    const kb = this.container;

    kb.addEventListener('touchstart', e => {
      e.preventDefault();
      AudioEngine.getCtx();
      Array.from(e.changedTouches).forEach(t => {
        const el = this._keyAt(t.clientX, t.clientY);
        if (el) { this.activeTouches.set(t.identifier, el); this._startNote(el); }
      });
    }, { passive: false });

    kb.addEventListener('touchmove', e => {
      e.preventDefault();
      Array.from(e.changedTouches).forEach(t => {
        const prev = this.activeTouches.get(t.identifier);
        const curr = this._keyAt(t.clientX, t.clientY);
        if (curr !== prev) {
          if (prev) this._stopNote(prev);
          if (curr) { this.activeTouches.set(t.identifier, curr); this._startNote(curr); }
          else       this.activeTouches.delete(t.identifier);
        }
      });
    }, { passive: false });

    const endAll = e => {
      e.preventDefault();
      Array.from(e.changedTouches).forEach(t => {
        const el = this.activeTouches.get(t.identifier);
        if (el) this._stopNote(el);
        this.activeTouches.delete(t.identifier);
      });
    };
    kb.addEventListener('touchend',    endAll, { passive: false });
    kb.addEventListener('touchcancel', endAll, { passive: false });
  },

  _bindMouse() {
    let held = null;
    const kb = this.container;
    kb.addEventListener('mousedown', e => {
      AudioEngine.getCtx();
      const el = this._keyAt(e.clientX, e.clientY);
      if (el) { held = el; this._startNote(el); }
    });
    kb.addEventListener('mousemove', e => {
      if (!held) return;
      const el = this._keyAt(e.clientX, e.clientY);
      if (el !== held) { this._stopNote(held); held = el; if (el) this._startNote(el); }
    });
    const up = () => { if (held) { this._stopNote(held); held = null; } };
    kb.addEventListener('mouseup',    up);
    kb.addEventListener('mouseleave', up);
  },
};

/* ── Oscilloscope ─────────────────────────────────────────────────────────── */
const Scope = {
  canvas: null,
  _raf:   null,

  init() {
    this.canvas = document.getElementById('waveform-display');
    this._resize();
    this._loop();
    window.addEventListener('resize', () => this._resize());
  },

  _resize() {
    const c = this.canvas;
    c.width  = Math.round(c.clientWidth  * devicePixelRatio);
    c.height = Math.round(c.clientHeight * devicePixelRatio);
  },

  _loop() {
    const draw = () => {
      this._raf = requestAnimationFrame(draw);
      const c   = this.canvas;
      const ctx = c.getContext('2d');
      const W   = c.width;
      const H   = c.height;

      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, W, H);

      if (!AudioEngine.analyser) {
        // flat line when no audio
        ctx.strokeStyle = '#2a3a22';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
        return;
      }

      const buf = new Float32Array(AudioEngine.analyser.fftSize);
      AudioEngine.analyser.getFloatTimeDomainData(buf);

      ctx.strokeStyle = '#9ab08a';
      ctx.lineWidth = 1.5 * devicePixelRatio;
      ctx.shadowColor = '#5a7050';
      ctx.shadowBlur  = 3 * devicePixelRatio;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / buf.length) * W;
        const y = (0.5 - buf[i] * 0.44) * H;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    draw();
  },
};

/* ── UI controller ────────────────────────────────────────────────────────── */
const UIController = {
  init() {
    this._clock();
    this._waveButtons();
    this._octaveButtons();
  },

  showNote(name) {
    const el = document.getElementById('note-display');
    if (el) el.textContent = name;
  },

  _clock() {
    const tick = () => {
      const d = new Date();
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const el = document.getElementById('clock');
      if (el) el.textContent = h + ':' + m;
    };
    tick();
    setInterval(tick, 15000);
  },

  _waveButtons() {
    document.querySelectorAll('[data-wave]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-wave]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        AppState.waveform = btn.dataset.wave;
        const lbl = document.getElementById('mode-label');
        if (lbl) lbl.textContent = btn.dataset.wave.slice(0, 3).toUpperCase();
      });
    });
  },

  _octaveButtons() {
    const updateInfo = () => {
      const b = 3 + AppState.octaveShift;
      const el = document.getElementById('te-info');
      if (el) el.textContent = 'C' + b + '·B' + (b + 1);
    };
    document.getElementById('btn-oct-down')?.addEventListener('click', () => {
      if (AppState.octaveShift > -2) { AppState.octaveShift--; updateInfo(); }
    });
    document.getElementById('btn-oct-up')?.addEventListener('click', () => {
      if (AppState.octaveShift < 2)  { AppState.octaveShift++; updateInfo(); }
    });
  },
};

/* ── Bootstrap ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  UIController.init();
  Scope.init();
  KeyboardUI.init();
  WheelUI.init();
});
