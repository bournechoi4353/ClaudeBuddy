// Speech-to-text worker — runs in an Electron utilityProcess (Electron's BUNDLED
// Node, so the user never needs to install Node). It loads Moonshine ASR via the
// already-installed @huggingface/transformers and transcribes 16kHz mono Float32
// audio sent from the main process over parentPort.
//
// Why a separate process and not main: main already has kokoro-js's onnxruntime
// loaded for TTS. A utilityProcess gives STT its OWN onnxruntime in its OWN
// process, so the two never collide (the SIGSEGV C.V.A's system-Node sidecar
// existed to avoid) and the ~250MB model download + inference never block main's
// agent loop, the tray, the TTS pipeline, or the crab animation. Proven by the
// Phase 2.0 TTS->STT round-trip spike.
//
// Protocol (parentPort messages; e.data is the payload):
//   in:  { type:'transcribe', id, samples:Float32Array }
//   out: { type:'ready' } | { type:'progress', progress }
//        { type:'result', id, text } | { type:'error', id, message } | { type:'fatal', message }

import { pipeline, env } from '@huggingface/transformers';

// Model cache → a writable dir passed in via fork env (the child can't call
// app.getPath()). Mirrors voice/tts.js so STT + TTS models share one cache dir.
if (process.env.STT_CACHE_DIR) env.cacheDir = process.env.STT_CACHE_DIR;

// Moonshine-base: built for short voice commands — compute scales with audio
// length instead of Whisper's fixed 30s pad, so a short utterance transcribes in
// well under a second. Fully local/free. Override with CLAWD_STT_MODEL.
const MODEL = process.env.CLAWD_STT_MODEL || 'onnx-community/moonshine-base-ONNX';

let asr = null;

async function load() {
  asr = await pipeline('automatic-speech-recognition', MODEL, {
    dtype: 'q8',
    progress_callback: (info) => {
      if (info && typeof info.progress === 'number') {
        process.parentPort.postMessage({ type: 'progress', progress: Math.round(info.progress) });
      }
    },
  });
  process.parentPort.postMessage({ type: 'ready' });
}

process.parentPort.on('message', async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'transcribe') return;
  try {
    const out = await asr(msg.samples);
    process.parentPort.postMessage({ type: 'result', id: msg.id, text: (out.text || '').trim() });
  } catch (err) {
    process.parentPort.postMessage({
      type: 'error',
      id: msg.id,
      message: err && err.message ? err.message : String(err),
    });
  }
});

load().catch((err) => {
  process.parentPort.postMessage({ type: 'fatal', message: err && err.stack ? err.stack : String(err) });
});
