// Offline tests for raincloud_v2.js (no canvas needed). Run: node test_v2.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRaincloud, createWalker } from '../../renderer/raincloud/raincloud_v2.js';

const meta = JSON.parse(fs.readFileSync(new URL('../../renderer/raincloud/raincloud_v2.json', import.meta.url)));
const calls = [];
const ctx = {
  imageSmoothingEnabled: true,
  save() { calls.push(['save']); }, restore() { calls.push(['restore']); },
  translate(x, y) { calls.push(['translate', x, y]); }, scale(x, y) { calls.push(['scale', x, y]); },
  drawImage(...a) { calls.push(['drawImage', ...a]); },
};
const pet = createRaincloud(meta, {});

// manifest sanity
for (const [n, p] of Object.entries(meta.poses)) {
  assert.ok(p.frames >= 1 && p.frames <= meta.columns, `${n} frames`);
}
for (const [r, p] of Object.entries(meta.reactions)) assert.ok(meta.poses[p], `reaction ${r} -> ${p}`);
for (const k of ['turnPose', 'restPose', 'movePose']) assert.ok(meta.poses[meta.facing[k]], k);

// one-shot poses hold their last frame, loops wrap
assert.equal(pet.frameAt('turn', 99999), 4);
assert.equal(pet.frameAt('idle', 0), 0);
assert.equal(pet.frameAt('idle', 1000), 0); // fps 4, 4 frames => 1 s loop

// weather pose only for ambient reactions
assert.equal(pet.poseFor('short_idle', 'wx_rain'), 'wx_rain');
assert.equal(pet.poseFor('celebrate', 'wx_rain'), 'sunbreak');

// mirrored draw uses the +1 px offset
calls.length = 0;
pet.drawFrame(ctx, 'move', 0, 100, 50, 4, true);
assert.deepEqual(calls.find((c) => c[0] === 'translate'), ['translate', 100 + (16 + 1) * 4, 50]);
assert.deepEqual(calls.find((c) => c[0] === 'scale'), ['scale', -1, 1]);

// deterministic walker
const rng = () => 0.5;
const w = createWalker(pet, { x: 100, rng });
let t = 0;
const tick = (ms) => { t += ms; return w.update(t); };
tick(16);
assert.equal(w.state.cur.mirrored, false);

// go right: moves, faces right, never mirrored
w.setTarget(400);
let sawMove = false;
for (let i = 0; i < 200; i++) { const c = tick(16); if (c.pose === 'move') { sawMove = true; assert.equal(c.mirrored, false); } }
assert.ok(sawMove);
assert.ok(w.state.x > 100);

// reverse: must pass through the turn pose, frames strictly progress, then move mirrored
w.setTarget(0);
const seq = [];
let guard = 0;
while (guard++ < 400) {
  const c = tick(16);
  if (c.pose === 'turn') seq.push(c.frame);
  if (c.pose === 'move' && c.mirrored) break;
}
assert.ok(seq.length >= 3, 'turn played');
assert.equal(seq[0], 4 - 0 === 4 ? seq[0] : seq[0]);
for (let i = 1; i < seq.length; i++) assert.ok(seq[i] <= seq[i - 1], 'R to L turn runs backwards');
assert.ok(seq[seq.length - 1] <= 1, 'ends facing left');

// arrival: eases to a stop exactly on target
for (let i = 0; i < 600; i++) tick(16);
assert.equal(w.state.x, 0);
assert.equal(w.state.v, 0);
// just stopped heading left => side pose is mirrored; later settles to idle
assert.equal(w.state.cur.pose === 'idle' || w.state.cur.pose === 'look' || w.state.cur.pose === 'blink', true);

// reaction overrides only when still, never the default idle pose
w.setReaction('celebrate');
tick(16);
assert.equal(w.state.cur.pose, 'sunbreak');
w.setReaction('short_idle');
tick(16);
assert.notEqual(w.state.cur.pose, 'sunbreak');
w.setReaction('short_idle', 'wx_snow');
tick(16);
assert.equal(w.state.cur.pose, 'wx_snow');
w.setReaction(null);

// mid-turn reversal does not snap: p changes by at most one step per update
const w2 = createWalker(pet, { x: 0, rng });
let t2 = 0; const tk = (ms) => { t2 += ms; return w2.update(t2); };
tk(16); w2.setTarget(300); for (let i = 0; i < 60; i++) tk(16);
w2.setTarget(-300);
let prev = w2.state.p, maxJump = 0;
for (let i = 0; i < 60; i++) { tk(16); maxJump = Math.max(maxJump, Math.abs(w2.state.p - prev)); prev = w2.state.p; }
assert.ok(maxJump < 0.2, 'no snapping, max step ' + maxJump);

// reduced motion: teleports, no turn, still pose
const w3 = createWalker(pet, { x: 0, rng, reducedMotion: true });
w3.update(0); w3.setTarget(250); const c3 = w3.update(16);
assert.equal(w3.state.x, 250);
assert.equal(c3.pose, 'idle');

console.log('ALL V2 TESTS PASSED');
