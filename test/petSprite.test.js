const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'petSprite.js'), 'utf8');
const meta = require('../renderer/raincloud/raincloud.json');
const rules = require('../vendor/pet-brain/rules.js');

// Run petSprite.js in a bare sandbox that stands in for the renderer.
function load(search, extra = {}) {
  const refreshed = [];
  const win = {
    location: { search },
    Crab: { refreshSize: () => refreshed.push(true) },
    ...extra,
  };
  const sandbox = {
    window: win,
    URLSearchParams,
    performance: { now: () => 0 },
    console: { warn() {} },
    setInterval, clearInterval,
    fetch: () => Promise.reject(new Error('no network in tests')),
    Image: class {},
  };
  vm.runInNewContext(SOURCE, sandbox);
  return { sprite: win.PetSprite, refreshed };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('without the petbrain query flag the sprite is inert', async () => {
  const { sprite, refreshed } = load('?scale=6');
  assert.strictEqual(sprite.wanted, false);
  assert.strictEqual(sprite.isReady(), false);
  assert.doesNotThrow(() => sprite.draw({}, 0, 0, 6, {}));
  await flush();
  assert.strictEqual(refreshed.length, 0, 'never touches the crab size');
});

test('sprite size follows the Size setting in whole pixel steps', () => {
  const { sprite } = load('?scale=6&petbrain=1');
  assert.strictEqual(sprite.wanted, true);
  assert.deepStrictEqual([4, 6, 9, 14].map((s) => sprite.sizeFor(s)), [48, 80, 112, 176]);
  for (const s of [1, 2, 3, 5, 7, 11]) assert.strictEqual(sprite.sizeFor(s) % 16, 0);
});

test('if the sheet fails to load, the crab comes back', async () => {
  const { sprite, refreshed } = load('?scale=6&petbrain=1');
  assert.strictEqual(sprite.wanted, true);
  await flush();
  await flush();
  assert.strictEqual(sprite.wanted, false);
  assert.strictEqual(sprite.isReady(), false);
  assert.ok(refreshed.length >= 1, 'asked the crab to resize back');
});

test('the shipped reactions map covers every reaction and points at real poses', () => {
  for (const reaction of rules.REACTIONS) {
    assert.ok(meta.reactions[reaction], `no pose for ${reaction}`);
    assert.ok(meta.poses[meta.reactions[reaction]], `pose for ${reaction} is not in the sheet`);
  }
  assert.deepStrictEqual(Object.keys(meta.reactions).filter((k) => !rules.REACTIONS.includes(k)), []);
});

test('the sheet matches the manifest and ambient reactions are known', () => {
  const rows = Object.values(meta.poses).map((p) => p.row);
  assert.strictEqual(new Set(rows).size, rows.length);
  assert.strictEqual(Math.max(...rows) + 1, 23);
  for (const name of meta.ambientReactions) {
    assert.ok(name === 'idle' || rules.REACTIONS.includes(name), `unknown ambient reaction ${name}`);
  }
  for (const file of [meta.image, meta.imageScale4x]) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'renderer', 'raincloud', file)), `${file} is missing`);
  }
  assert.strictEqual(meta.frameSize, 16);
  assert.strictEqual(meta.frameCount, 2);
});
