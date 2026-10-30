const test = require('node:test');
const assert = require('node:assert');
const { createReactionLayer } = require('../pet/reactions');
const { REACTION_CONFIG, MIN } = require('../pet/config');
const { createPetBrain } = require('../vendor/pet-brain/petBrain.js');
const canned = require('../vendor/pet-brain/canned.json');

const FOCUSED = { app_category: 'code_editor', idle_s: 0, typing: 'steady', hour: 14, music: 'none', event: 'none' };
const GREETING = { app_category: 'browser', idle_s: 0, typing: 'none', hour: 14, music: 'none', event: 'none' };
const STUCK = { ...GREETING, event: 'build_failed' };

// Small deterministic generator so shuffles are repeatable.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A layer on a fake clock with a stub brain that counts its calls.
function fixture(overrides = {}) {
  const clock = { t: 10_000_000 };
  const calls = [];
  let n = 0;
  const layer = createReactionLayer({
    now: () => clock.t,
    createBrain: () => ({
      react: async (signals) => {
        calls.push(signals);
        n += 1;
        return { reaction: require('../vendor/pet-brain/rules.js').reactionFor(signals), line: `line ${n}`, source: 'canned' };
      },
    }),
    ...overrides,
  });
  const advance = (ms) => { clock.t += ms; };
  return { layer, clock, calls, advance };
}

test('quiet right after launch, then allowed', async () => {
  const { layer, advance } = fixture();
  const early = await layer.consider(FOCUSED);
  assert.strictEqual(early.ok, false);
  assert.strictEqual(early.reason, 'startup-quiet');
  advance(REACTION_CONFIG.startupQuietMs + 1);
  const later = await layer.consider(FOCUSED);
  assert.strictEqual(later.ok, true);
  assert.strictEqual(later.reaction, 'focused');
});

test('per-reaction cooldown blocks a repeat until it expires', async () => {
  const { layer, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);

  advance(REACTION_CONFIG.globalMinGapMs + 1);
  const again = await layer.consider(FOCUSED);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, 'cooldown');

  advance(REACTION_CONFIG.cooldownMs.focused);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
});

test('global gap blocks a different reaction too soon after any bubble', async () => {
  const { layer, advance } = fixture();
  advance(REACTION_CONFIG.startupQuietMs + 1);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);

  advance(REACTION_CONFIG.globalMinGapMs - 1000);
  const tooSoon = await layer.consider(STUCK);
  assert.strictEqual(tooSoon.ok, false);
  assert.strictEqual(tooSoon.reason, 'global-gap');

  advance(1001);
  const ok = await layer.consider(STUCK);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.reaction, 'stuck');
});

test('a reaction with no configured cooldown uses the default', async () => {
  const { layer, advance } = fixture({ config: { cooldownMs: {}, defaultCooldownMs: 10 * MIN, globalMinGapMs: 1000, startupQuietMs: 0 } });
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
  advance(5 * MIN);
  assert.strictEqual((await layer.consider(FOCUSED)).reason, 'cooldown');
  advance(5 * MIN + 1);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
});

test('chattiness scales cooldowns and the global gap', async () => {
  for (const [level, factor] of [['low', 2], ['normal', 1], ['high', 0.5]]) {
    const { layer, advance } = fixture({ chattiness: level });
    advance(REACTION_CONFIG.startupQuietMs + 1);
    assert.strictEqual((await layer.consider(FOCUSED)).ok, true);

    advance(REACTION_CONFIG.cooldownMs.focused * factor - 1);
    advance(0);
    const early = await layer.consider(FOCUSED);
    assert.strictEqual(early.ok, false, `${level}: still cooling down`);
    advance(2);
    assert.strictEqual((await layer.consider(FOCUSED)).ok, true, `${level}: cooldown over`);
  }
});

test('setChattiness changes behavior live and ignores unknown values', async () => {
  const { layer } = fixture();
  assert.strictEqual(layer.getChattiness(), 'normal');
  layer.setChattiness('low');
  assert.strictEqual(layer.getChattiness(), 'low');
  layer.setChattiness('shouty');
  assert.strictEqual(layer.getChattiness(), 'low');
});

test('fullscreen blocks the bubble and does not use up the cooldown or a line', async () => {
  let fullscreen = true;
  const { layer, calls, advance } = fixture({ isFullscreen: async () => fullscreen });
  advance(REACTION_CONFIG.startupQuietMs + 1);
  const blocked = await layer.consider(FOCUSED);
  assert.strictEqual(blocked.reason, 'fullscreen');
  assert.strictEqual(calls.length, 0, 'brain was not asked for a line');

  fullscreen = false;
  const shown = await layer.consider(FOCUSED);
  assert.strictEqual(shown.ok, true);
  assert.strictEqual(calls.length, 1);
});

test('a failing fullscreen check is treated as not fullscreen', async () => {
  const { layer, advance } = fixture({ isFullscreen: async () => { throw new Error('no permission'); } });
  advance(REACTION_CONFIG.startupQuietMs + 1);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
});

test('gated calls never reach the brain', async () => {
  const { layer, calls, advance } = fixture();
  await layer.consider(FOCUSED); // startup quiet
  advance(REACTION_CONFIG.startupQuietMs + 1);
  await layer.consider(FOCUSED); // shown
  await layer.consider(FOCUSED); // global gap
  advance(REACTION_CONFIG.globalMinGapMs + 1);
  await layer.consider(FOCUSED); // cooldown
  assert.strictEqual(calls.length, 1);
});

test('a second call while one is in flight is refused', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { layer, advance } = fixture({ isFullscreen: () => gate.then(() => false) });
  advance(REACTION_CONFIG.startupQuietMs + 1);
  const first = layer.consider(FOCUSED);
  const second = await layer.consider(STUCK);
  assert.strictEqual(second.reason, 'busy');
  release();
  assert.strictEqual((await first).ok, true);
});

test('a throwing brain gives a quiet result, not an exception', async () => {
  const layer = createReactionLayer({
    now: () => 10_000_000,
    config: { startupQuietMs: 0 },
    createBrain: () => ({ react: async () => { throw new Error('boom'); } }),
  });
  const result = await layer.consider(FOCUSED);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'error');
  // and it recovers: the failed attempt did not start a cooldown
  assert.strictEqual((await layer.consider(FOCUSED)).reason, 'error');
});

test('resetLineHistory builds a fresh brain and keeps cooldowns', async () => {
  let built = 0;
  const clock = { t: 10_000_000 };
  const layer = createReactionLayer({
    now: () => clock.t,
    config: { startupQuietMs: 0 },
    createBrain: () => { built += 1; return { react: async (s) => ({ reaction: 'focused', line: 'x', source: 'canned' }) }; },
  });
  assert.strictEqual(built, 1);
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
  layer.resetLineHistory();
  assert.strictEqual(built, 2);
  clock.t += REACTION_CONFIG.globalMinGapMs + 1;
  assert.strictEqual((await layer.consider(FOCUSED)).reason, 'cooldown');
  layer.resetTimers();
  assert.strictEqual((await layer.consider(FOCUSED)).ok, true);
});

// ---- Shuffle bag, through the real pet brain ----

async function showMany(signals, count, seed) {
  const clock = { t: 10_000_000 };
  const layer = createReactionLayer({
    now: () => clock.t,
    config: { startupQuietMs: 0 },
    createBrain: () => createPetBrain({ random: seeded(seed) }),
  });
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    clock.t += 10 * 60 * MIN; // far past every cooldown
    const result = await layer.consider(signals);
    assert.strictEqual(result.ok, true, `show ${i}`);
    lines.push(result.line);
  }
  return lines;
}

test('shuffle bag: every line once per cycle, from the bank, across many seeds', async () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const lines = await showMany(FOCUSED, 40, seed);
    for (const line of lines) assert.ok(canned.focused.includes(line), `unknown line: ${line}`);
    for (let c = 0; c < lines.length; c += 5) {
      assert.strictEqual(new Set(lines.slice(c, c + 5)).size, 5, `seed ${seed} cycle ${c / 5} repeats a line`);
    }
  }
});

test('never the same line twice in a row, including across a reshuffle', async () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    for (const signals of [FOCUSED, GREETING, STUCK]) {
      const lines = await showMany(signals, 60, seed);
      for (let i = 1; i < lines.length; i += 1) {
        assert.notStrictEqual(lines[i], lines[i - 1], `seed ${seed}: repeat at ${i}`);
      }
    }
  }
});

test('a new cycle never starts with one of the last 3 lines shown', async () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const lines = await showMany(FOCUSED, 50, seed);
    for (let c = 5; c < lines.length; c += 5) {
      const recent = lines.slice(c - 3, c);
      assert.ok(!recent.includes(lines[c]), `seed ${seed}: cycle at ${c} starts with a recent line`);
    }
  }
});

test('different reactions keep separate bags', async () => {
  const clock = { t: 10_000_000 };
  const layer = createReactionLayer({
    now: () => clock.t,
    config: { startupQuietMs: 0 },
    createBrain: () => createPetBrain({ random: seeded(7) }),
  });
  const seen = { focused: new Set(), stuck: new Set() };
  for (let i = 0; i < 5; i += 1) {
    for (const [name, signals] of [['focused', FOCUSED], ['stuck', STUCK]]) {
      clock.t += 10 * 60 * MIN;
      const r = await layer.consider(signals);
      assert.strictEqual(r.reaction, name);
      seen[name].add(r.line);
    }
  }
  assert.strictEqual(seen.focused.size, 5);
  assert.strictEqual(seen.stuck.size, 5);
});
