// How renderer/crab.js drives the raincloud sprite: the sideways speed it reports, Reduce animation,
// pausing while the window is hidden, and that none of this applies to the crab. The sprite is a
// stand-in that records what crab.js hands it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CRAB = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'crab.js'), 'utf8');

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

function boot({ sprite = true, reduced = false } = {}) {
  const draws = [];
  const state = { reduced, hidden: false };
  const listeners = {};
  let frame = null;
  let clock = 0;
  const ctx = new Proxy({}, {
    get: (_t, name) => (name === 'measureText' ? (text) => ({ width: String(text).length * 6 }) : () => {}),
    set: () => true,
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx };
  const document = {
    get hidden() { return state.hidden; },
    getElementById: () => canvas,
    addEventListener(type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
  };
  const win = {
    innerWidth: 1280, innerHeight: 720, location: { search: sprite ? '?scale=6&petbrain=1' : '?scale=6' }, addEventListener() {},
    crabAPI: {
      getPrefs: () => Promise.resolve({ hasOnboarded: true }), setIgnoreMouse() {}, openMenu() {},
      onSetScale() {}, onReact() {}, onNotify() {}, onTimerEnded() {}, onPrefsUpdated() {},
    },
  };
  if (sprite) {
    win.PetSprite = {
      wanted: true,
      sizeFor: (scale) => 16 * Math.max(1, Math.round(scale * 0.75)),
      draw: (_ctx, x, y, scale, opts) => draws.push({ x, y, ...opts }),
      reducedMotion: () => state.reduced,
    };
  }
  const context = vm.createContext({
    window: win, document, URLSearchParams,
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { frame = cb; },
    setTimeout: () => 0, clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    console,
    Math: Object.assign(Object.create(Math), { random: seeded(11) }),
  });
  vm.runInContext(CRAB, context);
  const step = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      clock += 1000 / 60;
      const cb = frame;
      frame = null;
      if (!cb) return false;
      cb(clock);
    }
    return true;
  };
  return { draws, state, listeners, step, win, hasPendingFrame: () => frame !== null };
}

test('the sprite is told how fast the pet moves sideways, in the direction it moves', () => {
  const t = boot();
  t.step(4000);
  const moving = t.draws.filter((d) => d.vx !== 0);
  assert.ok(moving.length > 100, 'it walked');
  assert.ok(t.draws.some((d) => d.vx === 0), 'and it also stood still (idle, a pause at a wall)');
  for (const d of moving) assert.ok(Math.abs(d.vx) === 0.5 || Math.abs(d.vx) === 1, `a walk or scuttle step, got ${d.vx}`);
  // The reported direction matches how the position really changed.
  let agree = 0;
  let checked = 0;
  for (let i = 1; i < t.draws.length; i += 1) {
    const dx = t.draws[i].x - t.draws[i - 1].x;
    if (t.draws[i].vx !== 0 && dx !== 0) { checked += 1; if (Math.sign(dx) === Math.sign(t.draws[i].vx)) agree += 1; }
  }
  assert.ok(checked > 50 && agree === checked, `direction agrees with the movement (${agree} of ${checked})`);
  assert.ok(t.draws.every((d) => d.dragging === false && d.sleeping === false));
});

test('Reduce animation keeps the pet where it is', () => {
  const still = boot({ reduced: true });
  still.step(3000);
  assert.ok(still.draws.length > 0);
  assert.strictEqual(new Set(still.draws.map((d) => d.x)).size, 1, 'it never changes position');
  assert.ok(still.draws.every((d) => d.vx === 0));

  const normal = boot({ reduced: false });
  normal.step(3000);
  assert.ok(new Set(normal.draws.map((d) => d.x)).size > 10, 'without it, it roams');
});

test('Reduce animation can be turned on and off while running', () => {
  const t = boot();
  t.step(600);
  t.state.reduced = true;
  t.step(10);
  const frozenAt = t.draws[t.draws.length - 1].x;
  t.step(600);
  assert.strictEqual(t.draws[t.draws.length - 1].x, frozenAt);
  t.state.reduced = false;
  t.step(2000);
  assert.notStrictEqual(t.draws[t.draws.length - 1].x, frozenAt, 'roaming resumes');
});

test('the loop stops while the window is hidden and starts again when it is shown', () => {
  const t = boot();
  t.step(30);
  const before = t.draws.length;
  t.state.hidden = true;
  t.step(1); // this frame notices the window is hidden and asks for no more
  assert.strictEqual(t.hasPendingFrame(), false, 'no further frames are requested');
  assert.strictEqual(t.draws.length, before, 'nothing is drawn');
  assert.strictEqual(t.step(5), false, 'and nothing runs');

  t.state.hidden = false;
  t.listeners.visibilitychange.forEach((cb) => cb());
  assert.strictEqual(t.hasPendingFrame(), true, 'showing the window starts the loop again');
  t.step(30);
  assert.ok(t.draws.length > before, 'drawing resumes');
  t.listeners.visibilitychange.forEach((cb) => cb()); // a stray event while running must not start a second loop
  t.step(3);
  assert.strictEqual(t.draws.length - before > 0, true);
});

test('for the crab none of this exists: no visibility listener, no pause, no sprite calls', () => {
  const t = boot({ sprite: false });
  assert.strictEqual(t.listeners.visibilitychange, undefined, 'no listener is registered');
  t.state.hidden = true; // the crab loop does not look at this
  assert.strictEqual(t.step(120), true, 'the crab keeps running');
  assert.strictEqual(t.draws.length, 0);
});
