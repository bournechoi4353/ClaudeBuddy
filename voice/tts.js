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
const DTYPE = 'q8'; // ~92MB, loads + runs on this runtime

// Local Kokoro voices (free, offline), each with its tuned base speaking rate.
const VOICES = {
  af_bella: 1.15, // expressive female — default
  am_puck: 1.1, // playful male
};
const DEFAULT_VOICE = 'af_bella';

// ElevenLabs voices (premium cloud TTS — needs the user's API key, entered in
// Preferences). Far more expressive than Kokoro; used when a key is present and
// an el_ voice is selected. Any API failure falls back to Kokoro so Clawd never
// goes mute. IDs are ElevenLabs' stock premade voices.
const EL_VOICES = {
  el_rachel: '21m00Tcm4TlvDq8ikWAM', // Rachel — calm, natural female
  el_josh: 'TxGEqnHWrfWFTfGW9XjX', // Josh — young male
};
const EL_MODEL = 'eleven_flash_v2_5'; // lowest latency, 0.5x credit cost

// Voice + key are read live from prefs.json so Preferences / tray changes take
// effect without a restart. Cached briefly to avoid a file read per sentence.
let _vp = null;
let _vpAt = 0;
function voicePrefs() {
  if (_vp && Date.now() - _vpAt < 3000) return _vp;
  let voice = DEFAULT_VOICE;
  let elKey = '';
  try {
    const { app } = require('electron');
    const p = require('path').join(app.getPath('userData'), 'prefs.json');
    const prefs = JSON.parse(require('fs').readFileSync(p, 'utf8'));
    if (typeof prefs.elevenLabsKey === 'string') elKey = prefs.elevenLabsKey.trim();
    const valid = (v) => VOICES[v] || (elKey && EL_VOICES[v]);
    if (typeof prefs.voiceName === 'string' && valid(prefs.voiceName)) {
      voice = prefs.voiceName;
    } else if (elKey) {
      voice = 'el_rachel'; // key present, nothing valid picked → best voice wins
    }
  } catch (_) {
    /* defaults */
  }
  _vp = { voice, speed: VOICES[voice] || 1.0, elKey };
  _vpAt = Date.now();
  return _vp;
}

// ---- ElevenLabs backend ----
// pcm_24000 returns raw 16-bit PCM — drops straight into the existing playback
// path with no decode step. Per-sentence requests on the flash model keep
// first-audio latency in the few-hundred-ms range.
async function elevenSynthesize(text, voiceKey, apiKey) {
  const id = EL_VOICES[voiceKey];
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${id}?output_format=pcm_24000`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: EL_MODEL }),
    }
  );
  if (!res.ok) throw new Error(`elevenlabs ${res.status}`);
  const ab = await res.arrayBuffer();
  const pcm = new Int16Array(ab, 0, Math.floor(ab.byteLength / 2));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 0x8000;
  return { samples, rate: 24000 };
}

// Prosody contouring: Kokoro renders a question's rising intonation, but at a
// fast speaking rate the rise gets compressed into a flat statement. Deliver
// questions (and trail-offs) slower so the contour lands; exclamations a touch
// quicker. Statements keep the voice's full base rate.
function speedFor(text, base) {
  const t = text.trim();
  if (/\?$/.test(t)) return base * 0.85; // question — let the rise breathe
  if (/(\.\.\.|…)$/.test(t)) return base * 0.88; // trail-off — dreamy
  if (/!$/.test(t)) return base * 1.05; // exclamation — punchy
  return base;
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

// Local Kokoro synthesis (with prosody contouring — ElevenLabs doesn't need it,
// its prosody is natural out of the box).
async function kokoroSynthesize(text, voice, baseSpeed) {
  const speed = speedFor(text, baseSpeed);
  const tts = await getTts();
  const audio = await tts.generate(text, { voice, speed });
  return { samples: audio.audio, rate: audio.sampling_rate };
}

/** Synthesize text → { samples: Float32Array, rate: number }. */
async function synthesize(text) {
  const { voice, speed: base, elKey } = voicePrefs();
  const key = `${voice}|${base}|${text}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const { vlog } = require('./log');
  const t0 = Date.now();
  let speech;
  if (EL_VOICES[voice] && elKey) {
    try {
      speech = await elevenSynthesize(text, voice, elKey);
      vlog('tts', `elevenlabs ${Date.now() - t0}ms for ${(speech.samples.length / speech.rate).toFixed(1)}s ("${text.slice(0, 40)}")`);
    } catch (err) {
      // Quota out / network down / bad key — fall back to local Kokoro so the
      // crab never goes mute. Don't cache the fallback under the EL key.
      vlog('tts', `elevenlabs FAILED (${err && err.message ? err.message : err}) — kokoro fallback`);
      return kokoroSynthesize(text, DEFAULT_VOICE, VOICES[DEFAULT_VOICE]);
    }
  } else {
    speech = await kokoroSynthesize(text, voice, base);
    vlog('tts', `kokoro ${Date.now() - t0}ms for ${(speech.samples.length / speech.rate).toFixed(1)}s ("${text.slice(0, 40)}")`);
  }
  cache.set(key, speech);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return speech;
}

/** Keep-warm tick: run a tiny Kokoro inference so the model's pages stay
 *  resident through idle stretches (paged-out weights make the first reply
 *  synth slower than real-time → audible stutter). No-op until the model has
 *  been loaded by real use — never triggers the initial download. Bypasses the
 *  LRU cache on purpose; a cache hit wouldn't touch the weights. */
async function keepWarm() {
  if (loadState !== 'ready') return;
  const tts = await getTts();
  await tts.generate('hm', { voice: DEFAULT_VOICE, speed: 1.3 });
}

/** Fire-and-forget TLS warmup for the ElevenLabs path — after idle, the first
 *  per-sentence request otherwise pays DNS+TLS setup, which lands as a gap
 *  before/inside the spoken reply. Called when a voiced turn starts. */
function preconnect() {
  const { voice, elKey } = voicePrefs();
  if (!(EL_VOICES[voice] && elKey)) return;
  fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': elKey } }).catch(() => {});
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

module.exports = { synthesize, floatToInt16, ensureTts, getLoadState, keepWarm, preconnect };
