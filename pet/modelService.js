// Smart lines: the local model that writes ambient lines. Main process only.
//
// This is a backend for petBrain.js (hybrid mode). petBrain keeps the guards, the timeout and the
// built-in line bank; this service decides when the model is loaded.
//
//   - Lazy: nothing is loaded until the first ambient line asks for one.
//   - Never in the way: while the model is not ready, generate() answers at once with an
//     'abort' result, which petBrain treats as "use a built-in line" without counting a failure,
//     and the load runs in the background. So the first line after launch (or after an idle
//     unload) is a built-in line, and later ones come from the model.
//   - Warm: the model stays loaded while lines keep coming, and unloads after idleUnloadMs
//     without one.
//   - Off means off: with Smart lines off, or the model file missing or not the expected file,
//     it never loads anything and every line is a built-in line.
//
// The model runs in a worker thread inside the main process (vendor/pet-brain/worker.js), so
// inference never blocks the main thread. It is only ever asked for ambient lines. See pet/router.js.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { MODEL_CONFIG } = require('./config');
const manifest = require('../vendor/pet-brain/manifest.json').model;

// petBrain reads an 'abort' result as "no line from the model" and moves on to a built-in line.
const NO_LINE = Object.freeze({ text: '', stopReason: 'abort', bannedStop: false });

/** Streams the file and checks its size and SHA-256 against the manifest. Resolves { ok, why? }. */
function verifyModelFile(file, expected = manifest) {
  return new Promise((resolve) => {
    let size = 0;
    try { size = fs.statSync(file).size; } catch (_) { resolve({ ok: false, why: 'missing' }); return; }
    if (size !== expected.size_bytes) { resolve({ ok: false, why: 'size' }); return; }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve({ ok: false, why: 'unreadable' }));
    stream.on('end', () => resolve(hash.digest('hex') === expected.sha256 ? { ok: true } : { ok: false, why: 'hash' }));
  });
}

/** One plain sentence for the Preferences status line. */
function describeStatus(s) {
  if (!s.found) return 'Model not installed. Using the built-in lines.';
  if (s.matches === false) return 'The model file is not the expected one. Using the built-in lines.';
  const latency = s.lastLatencyMs == null ? '' : ` Last line: ${s.lastLatencyMs} ms.`;
  if (!s.enabled) return 'Model found. Smart lines are off.';
  if (s.state === 'loading') return 'Model found, loading...';
  if (s.state === 'loaded') return `Model found, loaded.${latency}`;
  if (s.state === 'error') return 'The model could not be loaded. Using the built-in lines for now.';
  return `Model found, idle. It loads with the next line.${latency}`;
}

/**
 * @param {{
 *   getPrefs?: () => object,
 *   env?: object,
 *   defaultModelPath?: string | null,
 *   createWorkerBackend: (options: object) => { start(): Promise<boolean>, generate(prompt: string, o?: object): Promise<any>, dispose(): Promise<void> },
 *   verify?: (file: string) => Promise<{ ok: boolean, why?: string }>,
 *   now?: () => number,
 *   log?: (message: string) => void,
 *   config?: Partial<typeof MODEL_CONFIG>,
 * }} deps
 */
function createModelService(deps) {
  const {
    getPrefs = () => ({}), env = process.env, defaultModelPath = null, createWorkerBackend,
    verify = verifyModelFile, now = Date.now, log = () => {},
  } = deps;
  const cfg = { ...MODEL_CONFIG, ...(deps.config || {}) };

  let inner = null;          // the worker backend while loaded
  let state = 'idle';        // idle | loading | loaded | error
  let lastLatencyMs = null;
  let lastLoadMs = null;
  let lastReason = null;     // why the last line did not come from the model
  let errorUntil = 0;
  let idleTimer = null;
  let matches = null;        // result of the size and hash check for the current file, null until run
  let checkedFile = '';      // the file that check was for
  let checkedStamp = '';     // and the size and modified time it was run against
  let generation = 0;        // bumped on every unload so a stale load can tell it was cancelled

  function enabled() {
    return getPrefs().petSmartLines === true;
  }

  function modelPath() {
    const p = getPrefs().petModelPath;
    if (typeof p === 'string' && p.trim()) return p.trim();
    if (env.PET_BRAIN_MODEL_PATH) return env.PET_BRAIN_MODEL_PATH;
    return defaultModelPath;
  }

  function fileFound(file) {
    try { return !!file && fs.statSync(file).isFile(); } catch (_) { return false; }
  }

  function clearIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => { unload('idle'); }, cfg.idleUnloadMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  async function unload(why) {
    generation += 1;
    clearIdleTimer();
    const old = inner;
    inner = null;
    if (state !== 'error') state = 'idle';
    if (old) {
      log(`model unloaded (${why})`);
      try { await old.dispose(); } catch (_) { /* already gone */ }
    }
  }

  async function load() {
    if (state === 'loading' || state === 'loaded' || now() < errorUntil) return;
    const file = modelPath();
    if (!enabled() || !fileFound(file)) return;
    const myGeneration = ++generation;
    state = 'loading';
    log('model loading');
    const fail = (why) => {
      state = 'error';
      errorUntil = now() + cfg.loadRetryMs;
      log(`model not loaded: ${why}`);
    };
    try {
      // Check the file once per file version. The hash is the real access control: only the expected model loads.
      const info = fs.statSync(file);
      const stamp = `${info.size}:${info.mtimeMs}`;
      if (file !== checkedFile || stamp !== checkedStamp) {
        const check = await verify(file);
        matches = check.ok;
        checkedFile = file;
        checkedStamp = stamp;
        if (!check.ok) { fail(`file check failed (${check.why})`); return; }
      } else if (matches === false) {
        fail('file check failed');
        return;
      }
      env.PET_BRAIN_GPU = cfg.gpu; // read by vendor/pet-brain/worker.js when the worker starts
      const backend = createWorkerBackend({
        modelPath: file, threads: cfg.threads, maxTokens: 28, temperature: 0.7, startupTimeoutMs: cfg.startupTimeoutMs,
      });
      const t0 = now();
      const ok = await backend.start();
      if (!ok) { try { await backend.dispose(); } catch (_) {} fail('worker did not start'); return; }
      if (myGeneration !== generation || !enabled()) { try { await backend.dispose(); } catch (_) {} state = 'idle'; return; }
      inner = backend;
      lastLoadMs = now() - t0;
      state = 'loaded';
      armIdleTimer();
      log(`model loaded in ${lastLoadMs} ms`);
    } catch (err) {
      fail(String((err && err.message) || err));
    }
  }

  // The backend petBrain talks to.
  const backend = {
    start: () => Promise.resolve(true), // lazy: nothing to start yet
    async generate(prompt, opts) {
      lastReason = null;
      if (!enabled()) { lastReason = 'off'; return NO_LINE; }
      const file = modelPath();
      if (!fileFound(file)) { lastReason = 'model-missing'; return NO_LINE; }
      if (matches === false && checkedFile === file) { lastReason = 'model-mismatch'; return NO_LINE; }
      if (state === 'error' && now() >= errorUntil) state = 'idle';
      if (state !== 'loaded') {
        lastReason = state === 'loading' ? 'loading' : state === 'error' ? 'load-failed' : 'cold-start';
        load().catch(() => {});
        return NO_LINE;
      }
      armIdleTimer();
      const t0 = now();
      try {
        const res = await inner.generate(prompt, opts);
        lastLatencyMs = now() - t0;
        return res;
      } catch (err) {
        lastReason = 'model-error';
        await unload('error');
        throw err;
      }
    },
    dispose: () => Promise.resolve(), // the service owns the model; see service.dispose()
  };

  return {
    backend,
    /** Why the most recent line was not written by the model (one-shot), or null. */
    takeFallbackReason() {
      const r = lastReason;
      lastReason = null;
      return r;
    },
    /** Apply a change of Smart lines or model path from Preferences. */
    configure() {
      if (!enabled()) unload('turned off');
      else if (state === 'error') { errorUntil = 0; state = 'idle'; }
      // A changed path is a new file: forget the check and drop the loaded model.
      if (checkedFile && checkedFile !== modelPath()) {
        checkedFile = '';
        checkedStamp = '';
        matches = null;
        unload('path changed');
      }
    },
    status() {
      const file = modelPath();
      const found = fileFound(file);
      return {
        enabled: enabled(), path: file || '', found, matches: found ? matches : null,
        state: found ? state : 'idle', lastLatencyMs, lastLoadMs, loadedModel: !!inner,
      };
    },
    statusLine() { return describeStatus(this.status()); },
    unload,
    dispose() { return unload('shutdown'); },
  };
}

module.exports = { createModelService, describeStatus, verifyModelFile, NO_LINE };
