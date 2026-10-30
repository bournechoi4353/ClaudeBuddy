'use strict';
// Pet brain: rules choose the reaction (always, instantly), a small local model writes the line,
// and a canned line is used whenever the model is missing, slow, busy, cooling down or wrong.
// react() never rejects and never waits longer than timeoutMs for the model.

const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { reactionFor, normalizeSignals } = require('./rules.js');
const { lineProblems, sanitizeLine } = require('./lineCheck.js');
const { personaProblems } = require('./personaCheck.js');
const { signalMismatches } = require('./consistency.js');
const { buildPrompt } = require('./linePrompt.js');
const defaultCanned = require('./canned.json');

const RECENT_LINES = 3;
const EXCLAIM_SPACING = 20; // at most one line with "!" in any 20 lines

function normLine(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}

/** Feature flag for the host app. Off unless PET_BRAIN_LOCAL=1. */
function isPetBrainEnabled(env = process.env) {
  return env.PET_BRAIN_LOCAL === '1';
}

/** A backend may answer with a plain string or with { text, stopReason, bannedStop }. */
function normalizeResult(res) {
  if (typeof res === 'string') return { text: res, stopReason: 'eogToken', bannedStop: false };
  return { text: String((res && res.text) || ''), stopReason: (res && res.stopReason) || 'eogToken', bannedStop: Boolean(res && res.bannedStop) };
}

/**
 * Backend that runs node-llama-cpp inside a worker thread, so the host event loop is never blocked.
 * Interface (also used by tests with a mock): start(), generate(prompt, { signal }), dispose().
 */
function createWorkerBackend({ modelPath, threads, maxTokens, temperature, startupTimeoutMs = 60000 }) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });

  function failAll(err) {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  }

  return {
    ready,
    start() {
      try {
        // In a packaged Electron app __dirname can be inside app.asar, where a worker file cannot be loaded.
        // Use the unpacked copy when it exists (see INTEGRATION.md, asarUnpack).
        let workerFile = path.join(__dirname, 'worker.js');
        const unpacked = workerFile.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        if (unpacked !== workerFile && fs.existsSync(unpacked)) workerFile = unpacked;
        worker = new Worker(workerFile, { workerData: { modelPath, threads, maxTokens, temperature } });
      } catch (err) {
        readyResolve(false);
        return Promise.resolve(false);
      }
      const timer = setTimeout(() => readyResolve(false), startupTimeoutMs);
      if (timer.unref) timer.unref();
      worker.on('message', (m) => {
        if (m.type === 'ready') { clearTimeout(timer); readyResolve(true); }
        else if (m.type === 'init-error') { clearTimeout(timer); readyResolve(false); }
        else if (m.type === 'result' && pending.has(m.id)) {
          pending.get(m.id).resolve({ text: m.text, stopReason: m.stopReason, bannedStop: m.bannedStop });
          pending.delete(m.id);
        } else if (m.type === 'gen-error' && pending.has(m.id)) { pending.get(m.id).reject(new Error(m.message)); pending.delete(m.id); }
      });
      worker.on('error', () => { readyResolve(false); failAll(new Error('worker error')); });
      worker.on('exit', () => { readyResolve(false); failAll(new Error('worker exited')); });
      return ready;
    },
    generate(prompt, { signal } = {}) {
      return new Promise((resolve, reject) => {
        if (!worker) { reject(new Error('worker not started')); return; }
        const id = ++seq;
        pending.set(id, { resolve, reject });
        if (signal) signal.addEventListener('abort', () => worker && worker.postMessage({ type: 'abort', id }), { once: true });
        worker.postMessage({ type: 'generate', id, prompt });
      });
    },
    dispose() {
      failAll(new Error('disposed'));
      if (worker) { const w = worker; worker = null; return w.terminate(); }
      return Promise.resolve();
    },
  };
}

/**
 * @param {{ modelPath?: string, timeoutMs?: number, cooldownMs?: number, canned?: Record<string,string[]>,
 *   threads?: number, maxTokens?: number, temperature?: number, abortGraceMs?: number, resampleMinRemainingMs?: number,
 *   consistencyGuard?: boolean, backend?: object, now?: () => number, random?: () => number }} options
 */
function createPetBrain(options = {}) {
  const {
    modelPath, timeoutMs = 1500, cooldownMs = 3000, canned = defaultCanned, threads, maxTokens = 28, temperature = 0.7,
    abortGraceMs = 2000, resampleMinRemainingMs = 650, consistencyGuard = true, now = Date.now, random = Math.random,
  } = options;

  let backend = options.backend || null;
  if (!backend && modelPath && fs.existsSync(modelPath)) {
    backend = createWorkerBackend({ modelPath, threads, maxTokens, temperature });
  }

  let modelReady = false;
  let disposed = false;
  let busy = false;
  let lastModelAt = -Infinity;
  let consecutiveFailures = 0;
  let sinceExclaim = EXCLAIM_SPACING; // lines returned since the last line with "!"
  const recent = []; // normalized recent lines, newest last
  const stats = { model: 0, canned: 0, timeouts: 0, truncated: 0, bannedStops: 0, resamples: 0, rejected: {} };
  const reject = (why) => { stats.rejected[why] = (stats.rejected[why] || 0) + 1; return null; };

  const ready = (async () => {
    if (!backend) return false;
    try {
      const ok = await backend.start();
      modelReady = ok !== false;
    } catch (err) {
      modelReady = false;
    }
    return modelReady;
  })();

  function remember(line) {
    recent.push(normLine(line));
    while (recent.length > RECENT_LINES) recent.shift();
    sinceExclaim = line.includes('!') ? 0 : sinceExclaim + 1;
  }

  // Canned lines are shown in cycles: every line of a reaction is shown once, in a shuffled order, before any line comes round again.
  // The start of a new cycle is ordered so that no line repeats within the last RECENT_LINES lines shown for that reaction.
  const bags = new Map(); // reaction -> lines still to show in the current cycle
  const shown = new Map(); // reaction -> lines shown from the bank, newest last

  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1)) % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function nextCycle(reaction, list) {
    const hist = shown.get(reaction) || [];
    const k = Math.min(RECENT_LINES, list.length - 1);
    for (let tries = 0; tries < 200; tries += 1) {
      const order = shuffled(list);
      let ok = true;
      for (let j = 0; j < k && ok; j += 1) if (hist.slice(hist.length - (k - j)).includes(order[j])) ok = false;
      if (ok) return order;
    }
    const order = shuffled(list); // very small banks: at least never the same line twice in a row
    const last = hist[hist.length - 1];
    if (order.length > 1 && order[0] === last) [order[0], order[order.length - 1]] = [order[order.length - 1], order[0]];
    return order;
  }

  function cannedFor(reaction) {
    const list = (canned[reaction] && canned[reaction].length ? canned[reaction] : canned.greeting) || ['Fine.'];
    let bag = bags.get(reaction);
    if (!bag || !bag.length) { bag = nextCycle(reaction, list); bags.set(reaction, bag); }
    // Take the next line of the cycle, skipping any line shown recently from any source; a skipped line stays in the cycle.
    let idx = bag.findIndex((l) => !recent.includes(normLine(l)));
    if (sinceExclaim < EXCLAIM_SPACING) {
      const calm = bag.findIndex((l) => !recent.includes(normLine(l)) && !l.includes('!'));
      if (calm >= 0) idx = calm;
    }
    if (idx < 0) idx = 0;
    const line = bag.splice(idx, 1)[0];
    const hist = shown.get(reaction) || [];
    hist.push(line);
    while (hist.length > 6) hist.shift();
    shown.set(reaction, hist);
    return line;
  }

  function finish(reaction, line, source) {
    remember(line);
    stats[source] += 1;
    return { reaction, line, source };
  }

  /** Check a finished model answer. Returns an acceptable line or null. */
  function accept(res, signals) {
    if (res.stopReason === 'maxTokens') { stats.truncated += 1; return reject('truncated'); }
    if (res.stopReason === 'abort') return reject('aborted');
    const line = sanitizeLine(res.text);
    if (lineProblems(line).length) { consecutiveFailures += 1; return reject('invalid'); }
    if (personaProblems(line).length) { consecutiveFailures += 1; return reject('persona'); }
    // A line that contradicts the signals (wrong time of day, an app that is not open, a duration with no basis)
    // is not a model failure, just not shown.
    if (consistencyGuard && signalMismatches(line, signals).length) return reject('contradicts-signals');
    if (line.includes('!') && sinceExclaim < EXCLAIM_SPACING) return reject('exclamation-rate');
    if (recent.includes(normLine(line))) return reject('repeat');
    consecutiveFailures = 0;
    return line;
  }

  /** Try the model, with one resample if it said a banned word. Never throws. */
  async function tryModel(signals, reaction) {
    busy = true;
    lastModelAt = now();
    const start = now();
    const controller = new AbortController();
    let timer;
    let settled = false;
    const prompt = buildPrompt(signals, reaction);
    const work = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (attempt > 0) {
          if (timeoutMs - (now() - start) < resampleMinRemainingMs) return reject('no-time-to-resample');
          stats.resamples += 1;
        }
        if (controller.signal.aborted) return null;
        const res = normalizeResult(await backend.generate(prompt, { signal: controller.signal }));
        if (res.bannedStop) { stats.bannedStops += 1; continue; } // generation was stopped on a banned word: try once more
        return accept(res, signals);
      }
      consecutiveFailures += 1;
      return reject('banned-word');
    })().finally(() => { settled = true; busy = false; });
    work.catch(() => {}); // a late failure must not become an unhandled rejection
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    try {
      const out = await Promise.race([work, timeout]);
      if (out === 'timeout') {
        controller.abort();
        stats.timeouts += 1;
        consecutiveFailures += 1;
        const grace = setTimeout(() => {
          if (!settled) { modelReady = false; Promise.resolve(backend.dispose && backend.dispose()).catch(() => {}); }
        }, abortGraceMs);
        if (grace.unref) grace.unref();
        return null;
      }
      return out;
    } catch (err) {
      consecutiveFailures += 1;
      return reject('error');
    } finally {
      clearTimeout(timer);
    }
  }

  async function react(signals) {
    let reaction = 'greeting';
    try {
      reaction = reactionFor(signals);
      const canUseModel = !disposed && backend && modelReady && !busy && consecutiveFailures < 3 &&
        now() - lastModelAt >= cooldownMs;
      if (canUseModel) {
        const line = await tryModel(normalizeSignals(signals), reaction);
        if (line) return finish(reaction, line, 'model');
      }
      return finish(reaction, cannedFor(reaction), 'canned');
    } catch (err) {
      return { reaction, line: cannedFor(reaction), source: 'canned' };
    }
  }

  async function dispose() {
    disposed = true;
    modelReady = false;
    try { if (backend && backend.dispose) await backend.dispose(); } catch (err) { /* ignore */ }
  }

  return { react, dispose, ready, stats: () => ({ ...stats, rejected: { ...stats.rejected } }) };
}

module.exports = { createPetBrain, createWorkerBackend, isPetBrainEnabled };
