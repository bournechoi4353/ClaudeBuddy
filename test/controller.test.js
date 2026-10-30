const test = require('node:test');
const assert = require('node:assert');
const { createPetController } = require('../pet/controller');
const { REACTION_CONFIG } = require('../pet/config');
const { reactionFor } = require('../vendor/pet-brain/rules.js');

const START = new Date(2026, 5, 1, 14, 0, 0).getTime();

function fixture() {
  // idle 30 s means present but not typing, so ambient signals settle on 'greeting'.
  const state = { t: START, idle: 30, fullscreen: false, music: 'none' };
  const emitted = [];
  let n = 0;
  const controller = createPetController({
    now: () => state.t,
    env: {},
    platform: {
      isFrontmostFullscreen: async () => state.fullscreen,
      getMusicState: async () => state.music,
    },
    powerMonitor: { getSystemIdleTime: () => state.idle },
    emit: (channel, payload) => emitted.push({ channel, ...payload }),
    createBrain: () => ({
      react: async (signals) => { n += 1; return { reaction: reactionFor(signals), line: `line ${n}`, source: 'canned' }; },
    }),
  });
  const advance = (ms) => { state.t += ms; };
  return { controller, state, emitted, advance };
}

test('nothing is shown during the startup quiet period', async () => {
  const { controller, emitted } = fixture();
  controller.noteFrontApp('Google Chrome');
  controller.sample();
  const decision = await controller.evaluate();
  assert.strictEqual(decision.reason, 'startup-quiet');
  assert.strictEqual(emitted.length, 0);
});

test('after the quiet period a bubble is emitted from real signals', async () => {
  const { controller, emitted, advance } = fixture();
  controller.noteFrontApp('Google Chrome');
  controller.sample();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  const decision = await controller.evaluate();
  assert.strictEqual(decision.ok, true);
  assert.strictEqual(emitted.length, 1);
  assert.strictEqual(emitted[0].channel, 'pet-brain-bubble');
  assert.strictEqual(emitted[0].reaction, 'greeting');
  assert.strictEqual(emitted[0].line, 'line 1');
});

test('a pushed build_failed event becomes a stuck bubble once', async () => {
  const { controller, emitted, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  controller.pushEvent('build_failed');
  await controller.evaluate();
  assert.deepStrictEqual(emitted.map((e) => e.reaction), ['stuck']);
  advance(REACTION_CONFIG.globalMinGapMs + 1000);
  await controller.evaluate();
  assert.ok(!emitted.slice(1).some((e) => e.reaction === 'stuck'), 'the event is not reported twice');
});

test('an event blocked by the global gap is retried briefly, then dropped as stale', async () => {
  const { controller, emitted, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  await controller.evaluate(); // some ambient bubble
  assert.strictEqual(emitted.length, 1);

  advance(10 * 1000);
  controller.pushEvent('build_passed');
  const blocked = await controller.evaluate();
  assert.strictEqual(blocked.reason, 'global-gap');
  assert.strictEqual(emitted.length, 1);

  // The gap (2 min) outlasts an event's life (1 min), so the old event is gone by then.
  advance(REACTION_CONFIG.globalMinGapMs);
  await controller.evaluate();
  assert.ok(!emitted.some((e) => e.reaction === 'celebrate'), 'stale event is not shown late');

  // A fresh event after the gap shows normally.
  controller.pushEvent('build_passed');
  await controller.evaluate();
  assert.strictEqual(emitted[emitted.length - 1].reaction, 'celebrate');
});

test('fullscreen keeps the event pending and shows nothing', async () => {
  const { controller, state, emitted, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  state.fullscreen = true;
  controller.pushEvent('error_dialog');
  const blocked = await controller.evaluate();
  assert.strictEqual(blocked.reason, 'fullscreen');
  assert.strictEqual(emitted.length, 0);

  advance(5 * 1000);
  state.fullscreen = false;
  await controller.evaluate();
  assert.deepStrictEqual(emitted.map((e) => e.reaction), ['error_spotted']);
});

test('the frontmost app and music state feed the signals', async () => {
  const { controller, emitted, state, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.noteFrontApp('Visual Studio Code');
  state.music = 'playing';
  controller.start();
  controller.stop();
  await new Promise((resolve) => setImmediate(resolve)); // let the first music refresh land
  controller.sample();
  await controller.evaluate();
  assert.strictEqual(emitted[0].reaction, 'music_vibe');
});

test('start twice and stop are safe, and dispose clears the timers', async () => {
  const { controller } = fixture();
  controller.start();
  controller.start();
  controller.stop();
  await controller.dispose();
});

test('a throwing platform or power monitor never breaks sampling', async () => {
  let t = START;
  const controller = createPetController({
    now: () => t,
    env: {},
    platform: { isFrontmostFullscreen: async () => { throw new Error('x'); }, getMusicState: async () => { throw new Error('y'); } },
    powerMonitor: { getSystemIdleTime: () => { throw new Error('z'); } },
    createBrain: () => ({ react: async (s) => ({ reaction: reactionFor(s), line: 'ok', source: 'canned' }) }),
  });
  t += REACTION_CONFIG.startupQuietMs + 1000;
  assert.doesNotThrow(() => controller.sample());
  const decision = await controller.evaluate();
  assert.strictEqual(decision.ok, true);
});
