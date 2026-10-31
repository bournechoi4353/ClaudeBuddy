// Every pose name the app refers to must exist in the merged manifest, so a renamed or removed pose
// fails here and not on someone's screen. The three places names come from: the reaction map, the
// weather lookup, and the hidden pose cycler (which lists the sheet's own poses; its behavior is
// tested in petSpriteV2.test.js).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const meta = require('../renderer/raincloud/raincloud_v2.json');
const rules = require('../vendor/pet-brain/rules.js');
const { poseFor } = require('../vendor/pet-brain/weather.js');

const root = path.join(__dirname, '..');
const listFiles = (dir) => fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));

test('the reaction map covers every reaction and points only at poses in the sheet', () => {
  for (const reaction of rules.REACTIONS) {
    assert.ok(meta.reactions[reaction], `no pose for ${reaction}`);
  }
  for (const [reaction, pose] of Object.entries(meta.reactions)) {
    assert.ok(meta.poses[pose], `${reaction} -> ${pose} is not in the sheet`);
    assert.ok(rules.REACTIONS.includes(reaction), `${reaction} is in the map but is not a reaction`);
  }
  assert.ok(meta.poses[meta.defaultPose], 'the default pose exists');
});

test('every pose the weather lookup can return is in the sheet', () => {
  const codes = [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 97, 99];
  const returned = new Set();
  for (const code of codes) {
    for (const isDay of [0, 1]) {
      for (const tempC of [-20, 0, 15, 40]) {
        for (const windKmh of [0, 20, 80]) {
          const pose = poseFor({ code, isDay, tempC, windKmh });
          if (pose) returned.add(pose);
        }
      }
    }
  }
  assert.ok(returned.size >= 10, 'the lookup reaches a good spread of poses');
  for (const pose of returned) assert.ok(meta.poses[pose], `weather pose ${pose} is not in the sheet`);
});

test('every ambient reaction is a real reaction or the plain idle state', () => {
  for (const name of meta.ambientReactions) {
    assert.ok(name === 'idle' || rules.REACTIONS.includes(name), `unknown ambient reaction ${name}`);
  }
});

test('the facing, blink and glance poses the player needs are in the sheet', () => {
  const f = meta.facing;
  for (const name of [f.turnPose, f.restPose, f.movePose, ...f.directionalPoses, meta.blink.basePose, meta.blink.blinkPose, meta.glance.pose]) {
    assert.ok(meta.poses[name], `${name} is not in the sheet`);
  }
});

test('no source file writes a weather pose name that the sheet does not have', () => {
  const files = [...listFiles('renderer'), ...listFiles('pet'), ...listFiles('vendor/pet-brain'), 'main.js'];
  const names = new Set();
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/\bwx_[a-z_]+\b/g)) names.add(match[0]);
  }
  assert.ok(names.size > 0, 'the scan found the weather pose names');
  for (const name of names) {
    if (name === 'wx_nonsense') continue; // the tests use it on purpose
    assert.ok(meta.poses[name], `${name} is written in the source but is not in the sheet`);
  }
});
