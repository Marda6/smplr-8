'use strict';

// Sets --app-height to window.innerHeight so the layout fills exactly the
// visible viewport on all mobile browsers (Chrome Android ignores -webkit-fill-available)
function setAppHeight() {
  document.documentElement.style.setProperty('--app-height', window.innerHeight + 'px');
}
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 100));
setAppHeight();

const PAD_COUNT = 12;
const DB_NAME = 'smplr-db';
const DB_VERSION = 1;
const STORE_NAME = 'pad-audio';

// ── AppState ──────────────────────────────────────────────────────────────────
const AppState = {
  mode: 'play',          // 'play' | 'rec' | 'load' | 'clr'
  activePadIndex: null,
  isRecording: false,
  recordingPadIndex: null,
  longPressTimer: null,
};

// ── AudioEngine ───────────────────────────────────────────────────────────────
const AudioEngine = {
  ctx: null,

  getCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  },

  async decode(arrayBuffer) {
    return this.getCtx().decodeAudioData(arrayBuffer.slice(0));
  },

  play(pad) {
    if (!pad.audioBuffer) return;
    const ctx = this.getCtx();
    const src = ctx.createBufferSource();
    src.buffer = pad.audioBuffer;
    src.connect(ctx.destination);
    pad.el.classList.add('is-playing');
    src.onended = () => pad.el.classList.remove('is-playing');
    src.start(0);
    pad.playbackStart = ctx.currentTime;
    pad.playbackDuration = pad.audioBuffer.duration;
    WaveformRenderer.startPlaybackLine(pad);
  },
};

// ── StorageManager ────────────────────────────────────────────────────────────
const StorageManager = {
  db: null,

  async open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => e.target.result.createObjectStore(STORE_NAME);
      req.onsuccess = e => { this.db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },

  async savePadAudio(index, arrayBuffer) {
    if (!this.db) return;
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(arrayBuffer, index);
  },

  async loadPadAudio(index) {
    if (!this.db) return null;
    return new Promise(resolve => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(index);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  },

  async deletePadAudio(index) {
    if (!this.db) return;
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(index);
  },

  saveName(index, name) {
    localStorage.setItem(`smplr_pad_${index}_name`, name);
  },

  loadName(index) {
    return localStorage.getItem(`smplr_pad_${index}_name`) || `PAD ${String(index + 1).padStart(2, '0')}`;
  },

  deleteName(index) {
    localStorage.removeItem(`smplr_pad_${index}_name`);
  },
};

// ── WaveformRenderer ──────────────────────────────────────────────────────────
const WaveformRenderer = {
  mainCanvas: null,
  mainCtx: null,
  playbackRaf: null,

  init() {
    this.mainCanvas = document.getElementById('waveform-display');
    this.mainCtx = this.mainCanvas.getContext('2d');
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this.drawIdle();
  },

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.mainCanvas.getBoundingClientRect();
    this.mainCanvas.width = rect.width * dpr;
    this.mainCanvas.height = rect.height * dpr;
    this.mainCtx.scale(dpr, dpr);
  },

  drawIdle() {
    const ctx = this.mainCtx;
    const w = this.mainCanvas.getBoundingClientRect().width;
    const h = this.mainCanvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#1e2e18';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  },

  extractWaveform(audioBuffer, samples = 300) {
    const data = audioBuffer.getChannelData(0);
    const step = Math.floor(data.length / samples);
    const result = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      let max = 0;
      for (let j = 0; j < step; j++) {
        const v = Math.abs(data[i * step + j]);
        if (v > max) max = v;
      }
      result[i] = max;
    }
    return result;
  },

  drawMain(waveformData, pad) {
    if (this.playbackRaf) {
      cancelAnimationFrame(this.playbackRaf);
      this.playbackRaf = null;
    }
    const ctx = this.mainCtx;
    const w = this.mainCanvas.getBoundingClientRect().width;
    const h = this.mainCanvas.getBoundingClientRect().height;
    ctx.clearRect(0, 0, w, h);

    if (!waveformData) { this.drawIdle(); return; }

    ctx.strokeStyle = '#9ab08a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mid = h / 2;
    for (let i = 0; i < waveformData.length; i++) {
      const x = (i / waveformData.length) * w;
      const amp = waveformData[i] * mid * 0.9;
      ctx.moveTo(x, mid - amp);
      ctx.lineTo(x, mid + amp);
    }
    ctx.stroke();

    if (pad) this._drawPlaybackLine(pad, waveformData, w, h);
  },

  startPlaybackLine(pad) {
    if (this.playbackRaf) cancelAnimationFrame(this.playbackRaf);
    const w = this.mainCanvas.getBoundingClientRect().width;
    const h = this.mainCanvas.getBoundingClientRect().height;
    const draw = () => {
      const elapsed = AudioEngine.ctx.currentTime - pad.playbackStart;
      const progress = Math.min(elapsed / pad.playbackDuration, 1);
      if (!pad.waveformData) return;
      this.drawMain(pad.waveformData);
      const ctx = this.mainCtx;
      const x = progress * w;
      ctx.strokeStyle = '#e8632a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      if (progress < 1) this.playbackRaf = requestAnimationFrame(draw);
    };
    this.playbackRaf = requestAnimationFrame(draw);
  },

  _drawPlaybackLine(pad, waveformData, w, h) {},

  drawThumbnail(canvas, waveformData) {
    if (!canvas || !waveformData) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#9ab08a';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    const mid = h / 2;
    for (let i = 0; i < waveformData.length; i++) {
      const x = (i / waveformData.length) * w;
      const amp = waveformData[i] * mid * 0.85;
      ctx.moveTo(x, mid - amp);
      ctx.lineTo(x, mid + amp);
    }
    ctx.stroke();
  },

  // Live oscilloscope during recording
  liveRaf: null,
  liveAnalyser: null,

  startLive(analyser) {
    this.liveAnalyser = analyser;
    const data = new Float32Array(analyser.fftSize);
    const ctx = this.mainCtx;
    const draw = () => {
      analyser.getFloatTimeDomainData(data);
      const w = this.mainCanvas.getBoundingClientRect().width;
      const h = this.mainCanvas.getBoundingClientRect().height;
      ctx.clearRect(0, 0, w, h);
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const step = w / data.length;
      const mid = h / 2;
      for (let i = 0; i < data.length; i++) {
        const x = i * step;
        const y = mid + data[i] * mid * 0.9;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
      this.liveRaf = requestAnimationFrame(draw);
    };
    this.liveRaf = requestAnimationFrame(draw);
  },

  stopLive() {
    if (this.liveRaf) { cancelAnimationFrame(this.liveRaf); this.liveRaf = null; }
    this.liveAnalyser = null;
  },
};

// ── Recorder ──────────────────────────────────────────────────────────────────
const Recorder = {
  stream: null,
  mediaRecorder: null,
  chunks: [],
  targetPad: null,
  analyser: null,

  async start(pad) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (e) {
      UIController.setInfo('MIC DENIED');
      UIController.setMode('play');
      return;
    }
    const ctx = AudioEngine.getCtx();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    const src = ctx.createMediaStreamSource(this.stream);
    src.connect(this.analyser);

    this.chunks = [];
    this.targetPad = pad;
    this.mediaRecorder = new MediaRecorder(this.stream);
    this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => this._finalize();
    this.mediaRecorder.start(100);

    pad.el.classList.add('is-recording');
    AppState.isRecording = true;
    AppState.recordingPadIndex = pad.index;
    UIController.setInfo('● REC');
    WaveformRenderer.startLive(this.analyser);
  },

  stop() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    this.mediaRecorder.stop();
    this.stream.getTracks().forEach(t => t.stop());
    WaveformRenderer.stopLive();
    AppState.isRecording = false;
    AppState.recordingPadIndex = null;
  },

  async _finalize() {
    const pad = this.targetPad;
    pad.el.classList.remove('is-recording');
    UIController.setInfo('DECODING');

    const mimeType = this.mediaRecorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    const ab = await blob.arrayBuffer();

    try {
      const buffer = await AudioEngine.decode(ab);
      PadManager.assignBuffer(pad, buffer, ab);
      UIController.setInfo('READY');
    } catch (e) {
      UIController.setInfo('ERR DECODE');
    }
    UIController.setMode('play');
  },
};

// ── PadManager ────────────────────────────────────────────────────────────────
const PadManager = {
  pads: [],

  build() {
    const grid = document.getElementById('pad-grid');
    grid.innerHTML = '';
    this.pads = [];
    for (let i = 0; i < PAD_COUNT; i++) {
      const pad = {
        index: i,
        name: StorageManager.loadName(i),
        audioBuffer: null,
        waveformData: null,
        rawBuffer: null,
        el: null,
        playbackStart: 0,
        playbackDuration: 0,
      };

      const btn = document.createElement('button');
      btn.className = 'pad';
      btn.setAttribute('data-index', i);
      btn.innerHTML = `
        <canvas class="pad-wave"></canvas>
        <span class="pad-dot"></span>
        <span class="pad-number">${String(i + 1).padStart(2, '0')}</span>
        <span class="pad-name-label">${pad.name}</span>
      `;
      grid.appendChild(btn);
      pad.el = btn;
      this.pads.push(pad);

      btn.addEventListener('touchstart', e => { e.preventDefault(); this._onPadDown(pad); }, { passive: false });
      btn.addEventListener('mousedown', e => { e.preventDefault(); this._onPadDown(pad); });

      btn.addEventListener('touchend', e => { e.preventDefault(); clearTimeout(AppState.longPressTimer); }, { passive: false });
      btn.addEventListener('mouseup', () => clearTimeout(AppState.longPressTimer));
    }
  },

  _onPadDown(pad) {
    AudioEngine.getCtx(); // ensure init on first gesture

    clearTimeout(AppState.longPressTimer);

    const mode = AppState.mode;

    if (mode === 'play') {
      // Long press → rename
      AppState.longPressTimer = setTimeout(() => UIController.openRename(pad), 500);
      if (pad.audioBuffer) AudioEngine.play(pad);
      UIController.selectPad(pad);
      return;
    }

    if (mode === 'rec') {
      if (!AppState.isRecording) {
        Recorder.start(pad);
        UIController.selectPad(pad);
      } else if (AppState.recordingPadIndex === pad.index) {
        Recorder.stop();
      }
      return;
    }

    if (mode === 'load') {
      UIController.triggerLoad(pad);
      return;
    }

    if (mode === 'clr') {
      this.clearPad(pad);
      UIController.selectPad(pad);
      return;
    }
  },

  assignBuffer(pad, audioBuffer, rawBuffer) {
    pad.audioBuffer = audioBuffer;
    pad.rawBuffer = rawBuffer;
    pad.waveformData = WaveformRenderer.extractWaveform(audioBuffer);
    pad.el.classList.add('has-sample');
    const thumbCanvas = pad.el.querySelector('.pad-wave');
    WaveformRenderer.drawThumbnail(thumbCanvas, pad.waveformData);
    StorageManager.savePadAudio(pad.index, rawBuffer);
    if (AppState.activePadIndex === pad.index) {
      WaveformRenderer.drawMain(pad.waveformData, pad);
    }
  },

  clearPad(pad) {
    pad.audioBuffer = null;
    pad.waveformData = null;
    pad.rawBuffer = null;
    pad.el.classList.remove('has-sample');
    const thumbCanvas = pad.el.querySelector('.pad-wave');
    const ctx = thumbCanvas.getContext('2d');
    ctx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    StorageManager.deletePadAudio(pad.index);
    if (AppState.activePadIndex === pad.index) {
      WaveformRenderer.drawMain(null);
      UIController.setInfo('CLEARED');
    }
  },

  async restoreAll() {
    for (const pad of this.pads) {
      const ab = await StorageManager.loadPadAudio(pad.index);
      if (!ab) continue;
      try {
        const buffer = await AudioEngine.decode(ab);
        pad.audioBuffer = buffer;
        pad.rawBuffer = ab;
        pad.waveformData = WaveformRenderer.extractWaveform(buffer);
        pad.el.classList.add('has-sample');
        WaveformRenderer.drawThumbnail(pad.el.querySelector('.pad-wave'), pad.waveformData);
      } catch (e) {
        // corrupted audio — skip
      }
    }
  },
};

// ── UIController ──────────────────────────────────────────────────────────────
const UIController = {
  modeButtons: {},
  fileInput: null,
  loadTargetPad: null,

  init() {
    this.modeButtons = {
      play: document.getElementById('mode-play'),
      rec:  document.getElementById('mode-rec'),
      load: document.getElementById('mode-load'),
      clr:  document.getElementById('mode-clr'),
    };

    this.fileInput = document.getElementById('file-input');

    Object.entries(this.modeButtons).forEach(([mode, btn]) => {
      btn.addEventListener('click', () => this.setMode(mode));
      btn.addEventListener('touchstart', e => { e.preventDefault(); this.setMode(mode); }, { passive: false });
    });

    this.fileInput.addEventListener('change', () => this._onFileChange());

    document.getElementById('rename-confirm').addEventListener('click', () => this._confirmRename());
    document.getElementById('rename-cancel').addEventListener('click', () => this._closeRename());
    document.getElementById('rename-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') this._confirmRename();
      if (e.key === 'Escape') this._closeRename();
    });

    this._startClock();
  },

  setMode(mode) {
    if (AppState.isRecording) return; // don't switch while recording
    AppState.mode = mode;
    document.getElementById('mode-label').textContent = mode.toUpperCase();

    Object.entries(this.modeButtons).forEach(([m, btn]) => {
      btn.classList.toggle('active', m === mode);
    });

    const hints = { play: 'TAP TO PLAY', rec: 'TAP PAD → REC', load: 'TAP PAD → LOAD', clr: 'TAP PAD → CLR' };
    this.setInfo(hints[mode] || '');
  },

  selectPad(pad) {
    AppState.activePadIndex = pad.index;
    document.getElementById('pad-name-display').textContent = pad.name;
    if (pad.waveformData) {
      WaveformRenderer.drawMain(pad.waveformData, pad);
    } else {
      WaveformRenderer.drawMain(null);
    }
  },

  setInfo(text) {
    document.getElementById('te-info').textContent = text;
  },

  triggerLoad(pad) {
    this.loadTargetPad = pad;
    this.fileInput.click();
  },

  async _onFileChange() {
    const file = this.fileInput.files[0];
    if (!file || !this.loadTargetPad) { this.fileInput.value = ''; return; }
    this.setInfo('LOADING');
    const pad = this.loadTargetPad;
    this.loadTargetPad = null;
    try {
      const ab = await file.arrayBuffer();
      const buffer = await AudioEngine.decode(ab);
      PadManager.assignBuffer(pad, buffer, ab);
      this.selectPad(pad);
      this.setInfo('LOADED');
    } catch (e) {
      this.setInfo('ERR FORMAT');
    }
    this.fileInput.value = '';
    this.setMode('play');
  },

  openRename(pad) {
    this._renamePad = pad;
    const input = document.getElementById('rename-input');
    input.value = pad.name;
    document.getElementById('rename-overlay').hidden = false;
    setTimeout(() => { input.focus(); input.select(); }, 50);
  },

  _confirmRename() {
    if (!this._renamePad) return;
    const raw = document.getElementById('rename-input').value.trim().toUpperCase();
    const name = raw || this._renamePad.name;
    this._renamePad.name = name;
    this._renamePad.el.querySelector('.pad-name-label').textContent = name;
    StorageManager.saveName(this._renamePad.index, name);
    if (AppState.activePadIndex === this._renamePad.index) {
      document.getElementById('pad-name-display').textContent = name;
    }
    this._closeRename();
  },

  _closeRename() {
    document.getElementById('rename-overlay').hidden = true;
    this._renamePad = null;
  },

  _startClock() {
    const el = document.getElementById('clock');
    const tick = () => {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, '0');
      const m = String(now.getMinutes()).padStart(2, '0');
      el.textContent = `${h}:${m}`;
    };
    tick();
    setInterval(tick, 30000);
  },
};

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async () => {
  await StorageManager.open().catch(() => {});
  WaveformRenderer.init();
  PadManager.build();
  UIController.init();

  // Restore saved pads after first user gesture (AudioContext needs it)
  const restore = async () => {
    document.removeEventListener('touchstart', restore);
    document.removeEventListener('mousedown', restore);
    await PadManager.restoreAll();
  };
  document.addEventListener('touchstart', restore, { once: true, passive: true });
  document.addEventListener('mousedown', restore, { once: true });
})();
