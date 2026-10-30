// Runs renderer/crab.js in a bare sandbox with a seeded random generator, a fake clock and a
// canvas that records every draw call, and returns a hash of that recording. Two versions of
// the renderer that draw the same pixels in the same order give the same hash.

const vm = require('node:vm');
const crypto = require('node:crypto');

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

/**
 * @param {{ crab: string, petSprite?: string, frames?: number, seed?: number, search?: string }} options
 * @returns {{ hash: string, calls: number }}
 */
function recordCrab({ crab, petSprite, frames = 14000, seed = 7, search = '?scale=6' }) {
  const hash = crypto.createHash('sha256');
  let calls = 0;
  const log = (...parts) => { calls += 1; hash.update(parts.join('|') + '\n'); };

  const ctx = new Proxy({}, {
    get(_t, name) {
      if (name === 'measureText') return (text) => ({ width: String(text).length * 6 });
      return (...args) => log('call', String(name), ...args);
    },
    set(_t, name, value) { log('set', String(name), value); return true; },
  });
  const canvas = { width: 0, height: 0, getContext: () => ctx };

  let clock = 0;
  let frame = null;
  const handlers = {};
  const crabAPI = {
    onSetScale: (cb) => { handlers.scale = cb; },
    onReact: (cb) => { handlers.react = cb; },
    onNotify: (cb) => { handlers.notify = cb; },
    onTimerEnded: (cb) => { handlers.timer = cb; },
    onPrefsUpdated: (cb) => { handlers.prefs = cb; },
    getPrefs: () => Promise.resolve({ hasOnboarded: true }),
    setIgnoreMouse() {},
    openMenu() {},
  };
  const win = {
    innerWidth: 1280,
    innerHeight: 720,
    location: { search },
    crabAPI,
    addEventListener() {},
  };
  const sandbox = {
    window: win,
    document: { getElementById: () => canvas, addEventListener() {} },
    URLSearchParams,
    performance: { now: () => clock },
    requestAnimationFrame: (cb) => { frame = cb; },
    setTimeout: () => 0,
    clearTimeout() {},
    localStorage: { getItem: () => null, setItem() {} },
    console,
    // The raincloud sheet never finishes loading here, so a page that asks for it stays in the
    // "sprite wanted, not ready" state for the whole run.
    fetch: () => new Promise(() => {}),
    Image: class { set src(_v) {} },
    Math: Object.assign(Object.create(Math), { random: seeded(seed) }),
  };
  const context = vm.createContext(sandbox);
  if (petSprite) vm.runInContext(petSprite, context);
  vm.runInContext(crab, context);

  // A script of things that happen to the pet, spread across the run.
  const script = {
    100: () => handlers.notify({ text: 'hello there', durationMs: 3000 }),
    400: () => handlers.react({ type: 'app-switch' }),
    700: () => handlers.prefs({ skin: 'royal' }),
    900: () => win.Crab.handleToolUse('mcp__clawd__see_screen'),
    1200: () => handlers.scale({ scale: 9 }),
    1500: () => handlers.timer({ label: 'tea' }),
    2500: () => handlers.prefs({ skin: 'hacker', sleepMinutes: 2 }),
    3000: () => handlers.scale({ scale: 4 }),
  };

  for (let i = 0; i < frames; i += 1) {
    clock += 1000 / 60;
    if (script[i]) script[i]();
    const cb = frame;
    frame = null;
    if (!cb) throw new Error('crab.js stopped requesting frames');
    cb(clock);
  }
  return { hash: hash.digest('hex'), calls };
}

module.exports = { recordCrab };
