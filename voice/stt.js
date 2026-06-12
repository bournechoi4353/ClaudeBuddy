// Speech-to-text manager (main process). Spawns + drives the Moonshine STT worker
// in an Electron utilityProcess (Electron's bundled Node — no system Node needed),
// keeps it warm, respawns it if it dies, and exposes transcribe(samples) -> text.
//
// Architecture rationale + proof: see ROADMAP-VOICE-BETA.md Phase 2. The worker runs
// @huggingface/transformers (the same single copy kokoro-js uses) in its own process
// so its onnxruntime never collides with Kokoro's in main.

const path = require('path');
const { utilityProcess, app } = require('electron');

let worker = null;
let readyPromise = null;
let reqId = 0;
const pending = new Map(); // id -> { resolve, reject }
let onProgress = null;

function setSttProgress(fn) {
  onProgress = fn;
}

function workerPath() {
  // voice/stt-worker.mjs — bundled via build.files "voice/**". Loadable from asar
  // by utilityProcess (it's a JS module, not a native executable).
  return path.join(__dirname, 'stt-worker.mjs');
}

function startWorker() {
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve, reject) => {
    // Pass the writable model-cache dir in via env — the child can't call
    // app.getPath(). Same dir Kokoro uses (voice/tts.js).
    const cacheDir = path.join(app.getPath('userData'), 'voice-models');
    const w = utilityProcess.fork(workerPath(), [], {
      serviceName: 'clawd-stt',
      env: { ...process.env, STT_CACHE_DIR: cacheDir },
    });
    worker = w;

    w.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'ready') {
        resolve();
      } else if (msg.type === 'progress') {
        if (onProgress) try { onProgress(msg.progress); } catch (_) {}
      } else if (msg.type === 'result' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) { p.resolve(msg.text || ''); pending.delete(msg.id); }
      } else if (msg.type === 'error' && msg.id !== undefined) {
        const p = pending.get(msg.id);
        if (p) { p.reject(new Error(msg.message || 'transcription failed')); pending.delete(msg.id); }
      } else if (msg.type === 'fatal') {
        reject(new Error(msg.message || 'STT worker failed to start'));
      }
    });

    w.on('exit', () => {
      worker = null;
      readyPromise = null;
      for (const p of pending.values()) p.reject(new Error('STT worker exited'));
      pending.clear();
    });
  });

  return readyPromise;
}

/** Warm up the worker + model ahead of first use (e.g. when push-to-talk is enabled). */
async function ensureStt() {
  await startWorker();
}

async function transcribeOnce(samples) {
  await startWorker();
  const id = reqId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // utilityProcess.postMessage transfer-list accepts ONLY MessagePortMain, not
    // ArrayBuffers — so send the Float32Array by structured-clone copy (a PTT clip
    // is only a few hundred KB). (Phase 2.0 spike gotcha.)
    worker.postMessage({ type: 'transcribe', id, samples });
  });
}

/** Transcribe mono 16kHz Float32 audio → text. Retries once if the worker died. */
async function transcribe(samples) {
  // Too short to hold a word — skip the model call (accidental taps).
  if (!samples || samples.length < 3200) return '';
  const { vlog } = require('./log');
  const t0 = Date.now();
  try {
    const text = await transcribeOnce(samples);
    vlog('stt', `${Date.now() - t0}ms for ${(samples.length / 16000).toFixed(1)}s audio -> "${text.slice(0, 60)}"`);
    return text;
  } catch (err) {
    if (!/worker exited/i.test(err && err.message ? err.message : '')) throw err;
    vlog('stt', 'worker died mid-request — respawning + retrying');
    return await transcribeOnce(samples);
  }
}

/** Keep-warm tick: run a tiny inference so the model's pages stay resident
 *  through idle stretches. No-op if the worker was never started — keeping
 *  warm must never trigger the initial ~250MB download. */
async function keepWarm() {
  if (!worker) return;
  await transcribeOnce(new Float32Array(8000)); // 0.5s of silence — ~30ms run
}

module.exports = { ensureStt, transcribe, setSttProgress, keepWarm };
