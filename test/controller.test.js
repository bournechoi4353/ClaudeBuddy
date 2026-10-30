const test = require('node:test');
const assert = require('node:assert');
const { createPetController } = require('../pet/controller');
const { REACTION_CONFIG } = require('../pet/config');
const { reactionFor } = require('../vendor/pet-brain/rules.js');

const START = new Date(2026, 5, 1, 14, 0, 0).getTime();

function fixture() {
  // idle 30 s means present but not typing, so ambient signals settle on 'greeting'.
  const state = { t: START, idle: 30, fullscreen: false, music: 'none' };
  const emitted = []; // bubbles only
  const all = [];     // every message sent to the renderer
  let n = 0;
  const controller = createPetController({
    now: () => state.t,
    env: {},
    platform: {
      isFrontmostFullscreen: async () => state.fullscreen,
      getMusicState: async () => state.music,
    },
    powerMonitor: { getSystemIdleTime: () => state.idle },
    emit: (channel, payload) => {
      all.push({ channel, ...payload });
      if (channel === 'pet-brain-bubble') emitted.push({ channel, ...payload });
    },
    createBrain: () => ({
      react: async (signals) => { n += 1; return { reaction: reactionFor(signals), line: `line ${n}`, source: 'canned' }; },
    }),
  });
  const advance = (ms) => { state.t += ms; };
  return { controller, state, emitted, all, advance };
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

test('the sprite pose follows the live reaction, with a minimum dwell between changes', async () => {
  const { controller, state, all, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  await controller.evaluate();
  const states = () => all.filter((e) => e.channel === 'pet-brain-state').map((e) => e.reaction);
  assert.deepStrictEqual(states(), ['greeting']);

  // The situation changes right away: still inside the dwell, so the pose holds.
  state.idle = 120;
  advance(2000);
  controller.sample();
  await controller.evaluate();
  assert.deepStrictEqual(states(), ['greeting']);

  // After the dwell the pose follows.
  advance(10 * 1000);
  controller.sample();
  await controller.evaluate();
  assert.deepStrictEqual(states(), ['greeting', 'short_idle']);
});

test('an event changes the sprite pose immediately, ignoring the dwell', async () => {
  const { controller, all, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1000);
  controller.sample();
  await controller.evaluate();
  advance(1000);
  controller.pushEvent('build_failed');
  await controller.evaluate();
  const states = all.filter((e) => e.channel === 'pet-brain-state').map((e) => e.reaction);
  assert.deepStrictEqual(states, ['greeting', 'stuck']);
});

test('weather stays off until configured, then reports poses to the renderer', async () => {
  const sourcesMade = [];
  const emitted = [];
  const controller = createPetController({
    now: () => START,
    env: {},
    platform: { isFrontmostFullscreen: async () => false, getMusicState: async () => 'none' },
    powerMonitor: { getSystemIdleTime: () => 30 },
    emit: (channel, payload) => emitted.push({ channel, ...payload }),
    createBrain: () => ({ react: async (s) => ({ reaction: reactionFor(s), line: 'x', source: 'canned' }) }),
    createWeatherSource: (args) => { sourcesMade.push(args); return { getPose: async () => 'wx_rain' }; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(sourcesMade.length, 0, 'nothing is requested by default');

  controller.configureWeather({ enabled: true, place: { latitude: 39.04, longitude: -77.49 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepStrictEqual(sourcesMade, [{ latitude: 39.04, longitude: -77.49 }]);
  assert.deepStrictEqual(emitted.filter((e) => e.channel === 'pet-brain-weather').map((e) => e.pose), ['wx_rain']);

  controller.configureWeather({ enabled: false });
  assert.deepStrictEqual(emitted.filter((e) => e.channel === 'pet-brain-weather').map((e) => e.pose), ['wx_rain', null]);
  await controller.dispose();
});
