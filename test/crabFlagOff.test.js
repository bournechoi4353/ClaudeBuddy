// Flag-off regression guard. With the pet brain off, the renderer must draw exactly what it drew
// before the pet brain existed. GOLDEN is the hash of every draw call (about 2.6 million of them
// over roughly four minutes of frames, including walking, sleeping, a bubble, a hop, a skin
// accessory, a tool accessory and two size changes) recorded from renderer/crab.js at commit
// 35227a8, the last commit before the pet brain work.
//
// If you change how the crab looks or moves on purpose, rerun the recorder on the new crab.js and
// replace GOLDEN. If this fails and you did not mean to change the crab, something leaked.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { recordCrab } = require('./helpers/crabRecorder');

const GOLDEN = '2e125237da07b41d36733e8500f855ba1a48cfdba956450e0663661ce07be46b';
const CALLS = 2641291;

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'renderer', file), 'utf8');

test('flag off: the crab draws exactly as it did before the pet brain', () => {
  const result = recordCrab({ crab: read('crab.js'), petSprite: read('petSprite.js') });
  assert.strictEqual(result.calls, CALLS);
  assert.strictEqual(result.hash, GOLDEN);
});

test('control: asking for the raincloud sprite does change the drawing, so the guard can fail', () => {
  const result = recordCrab({
    crab: read('crab.js'),
    petSprite: read('petSprite.js'),
    search: '?scale=6&petbrain=1',
    frames: 600,
  });
  const baseline = recordCrab({ crab: read('crab.js'), petSprite: read('petSprite.js'), frames: 600 });
  assert.notStrictEqual(result.hash, baseline.hash);
});
