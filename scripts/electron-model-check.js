// Checks that node-llama-cpp and the pet brain's local model work inside Electron's MAIN process,
// which is where the library's docs say it must run. Not part of the app; run by hand:
//
//   env -u ELECTRON_RUN_AS_NODE PET_BRAIN_MODEL_PATH=/path/to/model.gguf ./node_modules/.bin/electron scripts/electron-model-check.js
//
// If node_modules/electron/dist is missing, point at any Electron 33 binary instead.
// Prints one JSON line per check and exits 0 only if every check passed.

const { app } = require('electron');
const fs = require('node:fs');
const { createWorkerBackend } = require('../vendor/pet-brain/petBrain.js');
const { buildPrompt } = require('../vendor/pet-brain/linePrompt.js');
const { sanitizeLine, lineProblems } = require('../vendor/pet-brain/lineCheck.js');

const modelPath = process.env.PET_BRAIN_MODEL_PATH;
const signals = { app_category: 'code_editor', idle_s: 5, typing: 'steady', hour: 15, music: 'none', event: 'none' };
const results = [];
const report = (check, data) => { results.push({ check, ...data }); console.log('CHECK ' + JSON.stringify({ check, ...data })); };

async function viaWorkerThread() {
  const backend = createWorkerBackend({ modelPath, threads: 4, maxTokens: 28, temperature: 0.7, startupTimeoutMs: 90000 });
  const t0 = Date.now();
  const ok = await backend.start();
  const loadMs = Date.now() - t0;
  if (!ok) { report('worker-thread-in-electron-main', { ok: false, why: 'model did not load', loadMs }); await backend.dispose(); return; }
  const lines = [];
  const times = [];
  for (let i = 0; i < 5; i += 1) {
    const t = Date.now();
    const res = await backend.generate(buildPrompt(signals, 'focused'));
    times.push(Date.now() - t);
    lines.push(sanitizeLine(typeof res === 'string' ? res : res.text));
  }
  await backend.dispose();
  report('worker-thread-in-electron-main', {
    ok: lines.every((l) => lineProblems(l).length === 0), loadMs, genMs: times, lines,
    electron: process.versions.electron, node: process.versions.node, arch: process.arch,
  });
}

async function directInMainThread() {
  const t0 = Date.now();
  const { getLlama } = await import('node-llama-cpp');
  // Same mode logic as the patched vendor/pet-brain/worker.js: macOS arm64 has no CPU-only binary.
  const metal = process.env.PET_BRAIN_GPU === 'metal';
  const cpuOnMac = !metal && process.platform === 'darwin' && process.arch === 'arm64';
  const llama = await getLlama({ gpu: metal || cpuOnMac ? 'metal' : false, logLevel: 'error' });
  const model = await llama.loadModel({ modelPath, ...(cpuOnMac ? { gpuLayers: 0 } : {}) });
  const loadMs = Date.now() - t0;
  await model.dispose();
  await llama.dispose();
  report('direct-in-electron-main-thread', { ok: true, loadMs });
}

app.whenReady().then(async () => {
  if (!modelPath || !fs.existsSync(modelPath)) {
    console.log('set PET_BRAIN_MODEL_PATH to the GGUF file');
    app.exit(2);
    return;
  }
  for (const step of [viaWorkerThread, directInMainThread]) {
    try { await step(); } catch (err) { report(step.name, { ok: false, error: String((err && err.stack) || err).slice(0, 600) }); }
  }
  app.exit(results.length === 2 && results.every((r) => r.ok) ? 0 : 1);
});
