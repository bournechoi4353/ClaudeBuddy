// Kokoro neural text-to-speech (local, free, offline) in the main process.
// Ported from C.V.A (src/main/tts.ts) to CommonJS. Lazy-loaded: the ~90MB model
// is only fetched + loaded the FIRST time Clawd actually speaks, so turning voice
// off (the default) keeps startup untouched.
//
// kokoro-js → onnxruntime-node (native N-API). Verified to load under Clawd's
// Electron 33 in the Phase 0 spike. Do NOT also import @huggingface/transformers
// in this process: it loads a second onnxruntime binding and the two ORT versions
// collide → SIGSEGV (documented in C.V.A).

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart'; // Kokoro's highest-graded voice
const DTYPE = 'q8'; // ~92MB, loads + runs on this runtime

// Voice + speed are read live from prefs.json so the tray "Voice"/"Speed" menus
// take effect without a restart. Cached briefly to avoid a file read per sentence.
let _vp = null;
let _vpAt = 0;
function voicePrefs() {
  if (_vp && Date.now() - _vpAt < 3000) return _vp;
  let voice = DEFAULT_VOICE;
  let speed = 1.0;
  try {
    const { app } = require('electron');
    const p = require('path').join(app.getPath('userData'), 'prefs.json');
    const prefs = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    if (typeof prefs.voiceName === 'string' && prefs.voiceName) voice = prefs.voiceName;
    if (typeof prefs.voiceSpeed === 'number' && prefs.voiceSpeed > 0) speed = prefs.voiceSpeed;
  } catch (_) {
    /* defaults */
  }
  _vp = { voice, speed };
  _vpAt = Date.now();
  return _vp;
}

let ttsPromise = null;
let loadState = 'idle'; // idle | loading | ready | error

// Redirect the model cache to a writable userData dir. kokoro-js's nested
// transformers otherwise caches module-relative — fine in dev, but a packaged
// app in /Applications can't write into its own bundle, so the first-run
// download would fail. Set before kokoro-js is imported.
function setModelCacheDir() {
  try {
    const { app } = require('electron');
    const dir = require('path').join(app.getPath('userData'), 'voice-models');
    process.env.TRANSFORMERS_CACHE = process.env.TRANSFORMERS_CACHE || dir;
    process.env.HF_HOME = process.env.HF_HOME || dir;
    process.env.HF_HUB_CACHE = process.env.HF_HUB_CACHE || dir;
  } catch (_) {
    /* not in Electron (e.g. spike) — fall back to default cache */
  }
}

function getTts() {
  if (!ttsPromise) {
    loadState = 'loading';
    ttsPromise = (async () => {
      setModelCacheDir();
      const { KokoroTTS } = await import('kokoro-js');
      const tts = await KokoroTTS.from_pretrained(MODEL, { dtype: DTYPE, device: 'cpu' });
      loadState = 'ready';
      return tts;
    })().catch((err) => {
      ttsPromise = null; // allow retry
      loadState = 'error';
      throw err;
    });
  }
  return ttsPromise;
}

function getLoadState() {
  return loadState;
}

/** Warm up the model (download + load) ahead of first use. */
async function ensureTts() {
  await getTts();
}

// Small LRU cache — confirmations and short repeats ("ok.", "done.") synthesize once.
const cache = new Map();
const CACHE_MAX = 24;

/** Synthesize text → { samples: Float32Array, rate: number }. */
async function synthesize(text) {
  const { voice, speed } = voicePrefs();
  const key = `${voice}|${speed}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const tts = await getTts();
  const audio = await tts.generate(text, { voice, speed });
  const speech = { samples: audio.audio, rate: audio.sampling_rate };
  cache.set(key, speech);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return speech;
}

/** Float32 PCM [-1,1] → Int16 PCM. Halves the IPC copy; inaudible at 16-bit. */
function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    out[i] = (v * 0x7fff) | 0;
  }
  return out;
}

module.exports = { synthesize, floatToInt16, ensureTts, getLoadState };
