const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelService, describeStatus, verifyModelFile } = require('../pet/modelService');
const { createPetBrain } = require('../vendor/pet-brain/petBrain.js');
const { MODEL_CONFIG } = require('../pet/config');

const FOCUSED = { app_category: 'code_editor', idle_s: 0, typing: 'steady', hour: 14, music: 'none', event: 'none' };
const GOOD_LINE = "Steady progress. I'll try to stay out of the way.";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function tempModel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'petmodel-'));
  const file = path.join(dir, 'model.gguf');
  fs.writeFileSync(file, 'not a real model');
  return file;
}

// A stand-in for the worker-thread backend. script.generate decides what the "model" says.
function fakeWorker(script = {}) {
  const made = [];
  const createWorkerBackend = (opts) => {
    const b = {
      opts, disposed: false, calls: 0,
      start: async () => script.startOk !== false,
      generate: async (prompt, o = {}) => { b.calls += 1; return script.generate ? script.generate(prompt, o.signal) : GOOD_LINE; },
      dispose: async () => { b.disposed = true; },
    };
    made.push(b);
    return b;
  };
  return { createWorkerBackend, made };
}

function setup({ prefs = { petSmartLines: true }, file = tempModel(), script, verify, config, env, now } = {}) {
  const worker = fakeWorker(script);
  const state = { prefs: { ...prefs }, file };
  const service = createModelService({
    getPrefs: () => state.prefs,
    env: env || {},
    defaultModelPath: file,
    createWorkerBackend: worker.createWorkerBackend,
    verify: verify || (async () => ({ ok: true })),
    config,
    ...(now ? { now } : {}),
  });
  const brain = createPetBrain({ backend: service.backend, timeoutMs: 100, cooldownMs: 0 });
  return { service, brain, worker, state, file };
}

// petBrain marks its backend ready one microtask after it is created. In the app the first bubble
// is at least 30 seconds away, so tests wait for it too.
async function setupReady(options) {
  const parts = setup(options);
  await parts.brain.ready;
  return parts;
}

// First line is always built in (the model is still loading). Wait for the load, then return.
async function warmUp(brain) {
  const first = await brain.react(FOCUSED);
  await tick();
  await tick();
  return first;
}

test('lazy: nothing is loaded until the first ambient line asks', async () => {
  const { service, worker } = await setupReady();
  assert.strictEqual(worker.made.length, 0);
  assert.strictEqual(service.status().state, 'idle');
  assert.strictEqual(service.status().found, true);
});

test('the first line is built in and loads the model in the background; the next line is the model', async () => {
  const { service, brain, worker } = await setupReady();
  const first = await brain.react(FOCUSED);
  assert.strictEqual(first.source, 'canned');
  assert.strictEqual(service.takeFallbackReason(), 'cold-start');
  await tick(); await tick();
  assert.strictEqual(worker.made.length, 1);
  assert.strictEqual(service.status().state, 'loaded');
  const second = await brain.react(FOCUSED);
  assert.strictEqual(second.source, 'model');
  assert.strictEqual(second.line, GOOD_LINE);
});

test('a load in progress never makes a line wait', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = fakeWorker();
  const slowFactory = (opts) => { const b = worker.createWorkerBackend(opts); b.start = async () => { await gate; return true; }; return b; };
  const service = createModelService({ getPrefs: () => ({ petSmartLines: true }), env: {}, defaultModelPath: tempModel(), createWorkerBackend: slowFactory, verify: async () => ({ ok: true }) });
  const brain = createPetBrain({ backend: service.backend, timeoutMs: 100, cooldownMs: 0 });
  const t0 = Date.now();
  const a = await brain.react(FOCUSED);
  const b = await brain.react(FOCUSED);
  assert.ok(Date.now() - t0 < 80, 'both lines came back at once');
  assert.deepStrictEqual([a.source, b.source], ['canned', 'canned']);
  assert.strictEqual(service.status().state, 'loading');
  release();
});

test('timeout falls back to a built-in line', async () => {
  const { service, brain } = await setupReady({
    script: { generate: (prompt, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: '', stopReason: 'abort' }))) },
  });
  await warmUp(brain);
  const result = await brain.react(FOCUSED);
  assert.strictEqual(result.source, 'canned');
  assert.strictEqual(brain.stats().timeouts, 1);
  assert.ok(service.status().loadedModel, 'a slow answer does not unload the model');
});

test('bad output falls back to a built-in line, whatever is wrong with it', async () => {
  const bad = {
    empty: '',
    tooLong: 'This line goes on and on and on with far too many words to be a short dry remark.',
    bannedWord: 'I am watching you work today.',
    twoLines: 'Steady progress.\nKeep going now.',
    nonAscii: 'Steady progress, café style, nothing to add.',
    cutOff: { text: 'Steady progress and then', stopReason: 'maxTokens' },
  };
  for (const [name, output] of Object.entries(bad)) {
    const { brain } = await setupReady({ script: { generate: () => output } });
    await warmUp(brain);
    const result = await brain.react(FOCUSED);
    assert.strictEqual(result.source, 'canned', name);
    assert.ok(result.line && result.line !== (typeof output === 'string' ? output : output.text), name);
    assert.strictEqual(brain.stats().model, 0, name);
  }
});

test('exclamation marks are rationed: the first is allowed, an immediate second falls back', async () => {
  const lines = ['Steady progress! Nobody panic here.', 'Smooth sailing! The code behaves today.'];
  let i = 0;
  const { brain } = await setupReady({ script: { generate: () => lines[i++ % 2] } });
  await warmUp(brain);
  const first = await brain.react(FOCUSED);
  const second = await brain.react(FOCUSED);
  assert.strictEqual(first.source, 'model');
  assert.strictEqual(second.source, 'canned');
  assert.strictEqual(brain.stats().rejected['exclamation-rate'], 1);
});

test('a model that throws falls back, unloads, and reloads on the next line', async () => {
  let calls = 0;
  const { service, brain, worker } = await setupReady({ script: { generate: () => { calls += 1; if (calls === 1) throw new Error('worker exited'); return GOOD_LINE; } } });
  await warmUp(brain);
  const failed = await brain.react(FOCUSED);
  assert.strictEqual(failed.source, 'canned');
  assert.strictEqual(service.status().state, 'idle');
  assert.strictEqual(worker.made[0].disposed, true);
  await brain.react(FOCUSED); // cold again, starts a reload
  await tick(); await tick();
  assert.strictEqual(worker.made.length, 2);
  assert.strictEqual((await brain.react(FOCUSED)).source, 'model');
});

test('model file missing behaves as off and says so', async () => {
  const { service, brain, worker } = await setupReady({ file: path.join(os.tmpdir(), 'definitely-not-here.gguf') });
  const result = await brain.react(FOCUSED);
  await tick();
  assert.strictEqual(result.source, 'canned');
  assert.strictEqual(service.takeFallbackReason(), 'model-missing');
  assert.strictEqual(worker.made.length, 0, 'never tried to load');
  assert.strictEqual(service.status().found, false);
  assert.strictEqual(service.statusLine(), 'Model not installed. Using the built-in lines.');
});

test('Smart lines off: built-in lines only, nothing loaded', async () => {
  const { service, brain, worker } = await setupReady({ prefs: { petSmartLines: false } });
  for (let i = 0; i < 3; i += 1) assert.strictEqual((await brain.react(FOCUSED)).source, 'canned');
  await tick();
  assert.strictEqual(worker.made.length, 0);
  assert.strictEqual(service.takeFallbackReason(), 'off');
  assert.strictEqual(service.status().enabled, false);
});

test('Smart lines is off unless the preference is exactly true', async () => {
  for (const value of [undefined, 'on', 1, null]) {
    const { brain, worker } = await setupReady({ prefs: { petSmartLines: value } });
    await brain.react(FOCUSED);
    await tick();
    assert.strictEqual(worker.made.length, 0, String(value));
  }
});

test('a file that is not the expected model is never loaded', async () => {
  const { service, brain, worker } = await setupReady({ verify: async () => ({ ok: false, why: 'hash' }) });
  await brain.react(FOCUSED);
  await tick(); await tick();
  assert.strictEqual(worker.made.length, 0);
  assert.strictEqual(service.status().matches, false);
  assert.strictEqual((await brain.react(FOCUSED)).source, 'canned');
  assert.strictEqual(service.takeFallbackReason(), 'model-mismatch');
  assert.match(service.statusLine(), /not the expected one/);
});

test('a failed load falls back, then retries after the wait', async () => {
  const clock = { t: 1_000_000 };
  const { service, brain, worker } = await setupReady({ script: { startOk: false }, now: () => clock.t });
  await brain.react(FOCUSED);
  await tick(); await tick();
  assert.strictEqual(service.status().state, 'error');
  assert.match(service.statusLine(), /could not be loaded/);
  assert.strictEqual(worker.made.length, 1);
  assert.strictEqual(worker.made[0].disposed, true, 'the dead worker is cleaned up');

  await brain.react(FOCUSED);
  await tick();
  assert.strictEqual(worker.made.length, 1, 'no retry inside the wait');

  clock.t += MODEL_CONFIG.loadRetryMs + 1;
  await brain.react(FOCUSED);
  await tick(); await tick();
  assert.strictEqual(worker.made.length, 2, 'retried after the wait');
});

test('the model unloads after the idle time, and the next line starts a reload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, brain, worker } = await setupReady({ config: { idleUnloadMs: 10 * 60 * 1000 } });
  // petBrain's own timeout timer is mocked too, so drive this one by hand with a short timeout.
  const first = brain.react(FOCUSED);
  await tick();
  await first;
  await tick(); await tick();
  assert.strictEqual(service.status().state, 'loaded');

  t.mock.timers.tick(10 * 60 * 1000 - 1);
  assert.strictEqual(service.status().state, 'loaded', 'still loaded just before the limit');
  t.mock.timers.tick(1);
  await tick();
  assert.strictEqual(service.status().state, 'idle');
  assert.strictEqual(worker.made[0].disposed, true);
});

test('each line pushes the idle unload back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, worker } = await setupReady({ config: { idleUnloadMs: 1000 } });
  await service.backend.generate('p'); // cold: starts the load
  await tick(); await tick();
  assert.strictEqual(service.status().state, 'loaded');
  t.mock.timers.tick(900);
  await service.backend.generate('p'); // a line: resets the timer
  t.mock.timers.tick(900);
  assert.strictEqual(service.status().state, 'loaded');
  t.mock.timers.tick(101);
  await tick();
  assert.strictEqual(service.status().state, 'idle');
  assert.strictEqual(worker.made[0].disposed, true);
});

test('turning Smart lines off unloads the model at once', async () => {
  const { service, brain, worker, state } = await setupReady();
  await warmUp(brain);
  assert.strictEqual(service.status().state, 'loaded');
  state.prefs.petSmartLines = false;
  service.configure();
  await tick();
  assert.strictEqual(service.status().state, 'idle');
  assert.strictEqual(worker.made[0].disposed, true);
});

test('changing the model path drops the loaded model', async () => {
  const { service, brain, worker, state } = await setupReady();
  await warmUp(brain);
  state.prefs.petModelPath = tempModel();
  service.configure();
  await tick();
  assert.strictEqual(worker.made[0].disposed, true);
  assert.strictEqual(service.status().state, 'idle');
});

test('the model path comes from Preferences, then the environment, then the default', () => {
  const a = tempModel(); const b = tempModel(); const c = tempModel();
  const make = (prefs, env) => createModelService({ getPrefs: () => prefs, env, defaultModelPath: c, createWorkerBackend: () => ({}) });
  assert.strictEqual(make({ petModelPath: a }, { PET_BRAIN_MODEL_PATH: b }).status().path, a);
  assert.strictEqual(make({}, { PET_BRAIN_MODEL_PATH: b }).status().path, b);
  assert.strictEqual(make({}, {}).status().path, c);
  assert.strictEqual(make({ petModelPath: '   ' }, {}).status().path, c);
});

test('the worker is told which GPU mode to use, and the load uses the configured threads', async () => {
  const env = {};
  const { brain, worker } = await setupReady({ env, config: { gpu: 'cpu', threads: 3 } });
  await warmUp(brain);
  assert.strictEqual(env.PET_BRAIN_GPU, 'cpu');
  assert.strictEqual(worker.made[0].opts.threads, 3);
  assert.strictEqual(worker.made[0].opts.maxTokens, 28);
});

test('the last line latency is recorded for the status line', async () => {
  const { service, brain } = await setupReady({ script: { generate: async () => { await new Promise((r) => setTimeout(r, 15)); return GOOD_LINE; } } });
  await warmUp(brain);
  assert.strictEqual(service.status().lastLatencyMs, null);
  await brain.react(FOCUSED);
  assert.ok(service.status().lastLatencyMs >= 10);
  assert.match(service.statusLine(), /Last line: \d+ ms/);
});

test('status line wording for each state', () => {
  const base = { found: true, matches: null, enabled: true, state: 'idle', lastLatencyMs: null };
  assert.match(describeStatus({ ...base, found: false }), /not installed/);
  assert.match(describeStatus({ ...base, matches: false }), /not the expected one/);
  assert.match(describeStatus({ ...base, enabled: false }), /Smart lines are off/);
  assert.match(describeStatus({ ...base, state: 'loading' }), /loading/);
  assert.match(describeStatus({ ...base, state: 'loaded', lastLatencyMs: 214 }), /loaded\. Last line: 214 ms/);
  assert.match(describeStatus({ ...base, state: 'error' }), /could not be loaded/);
  assert.match(describeStatus(base), /idle/);
});

test('verifyModelFile checks size and hash', async () => {
  const file = tempModel();
  const crypto = require('node:crypto');
  const sha = crypto.createHash('sha256').update('not a real model').digest('hex');
  assert.deepStrictEqual(await verifyModelFile(file, { size_bytes: 16, sha256: sha }), { ok: true });
  assert.deepStrictEqual(await verifyModelFile(file, { size_bytes: 15, sha256: sha }), { ok: false, why: 'size' });
  assert.deepStrictEqual(await verifyModelFile(file, { size_bytes: 16, sha256: 'f'.repeat(64) }), { ok: false, why: 'hash' });
  assert.deepStrictEqual(await verifyModelFile(path.join(os.tmpdir(), 'nope.gguf')), { ok: false, why: 'missing' });
});
