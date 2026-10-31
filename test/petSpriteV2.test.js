const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

// The real petSprite.js and the real v2 player, in a bare sandbox, drawing to a canvas that records its calls.
const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'petSprite.js'), 'utf8');
const meta = require('../renderer/raincloud/raincloud_v2.json');

let playerModule = null;
async function player() {
  if (!playerModule) playerModule = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'raincloud', 'raincloud_v2.js')).href);
  return playerModule;
}

function recorder() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    save() { calls.push(['save']); },
    restore() { calls.push(['restore']); },
    translate(x, y) { calls.push(['translate', x, y]); },
    scale(x, y) { calls.push(['scale', x, y]); },
    drawImage(...a) { calls.push(['drawImage', ...a]); },
  };
  return { ctx, calls };
}

const poseNames = Object.keys(meta.poses);
const poseAtRow = (row) => poseNames.find((n) => meta.poses[n].row === row);

// What one draw call put on the canvas.
function describe(calls) {
  const d = calls.find((c) => c[0] === 'drawImage');
  if (!d) return null;
  const mirrored = calls.some((c) => c[0] === 'scale');
  const translate = calls.find((c) => c[0] === 'translate');
  return {
    pose: poseAtRow(d[3] / 16), frame: d[2] / 16, mirrored,
    x: mirrored ? translate[1] : d[6], y: mirrored ? translate[2] : d[7], size: d[8],
  };
}

const FRAME_MS = 16;

async function setup({ search = '?scale=6&petbrain=1', extra = {}, walkerOptions = { rng: () => 0.5 } } = {}) {
  const clock = { t: 0 };
  const timers = [];
  const thoughts = [];
  const win = {
    location: { search },
    Crab: { refreshSize() {}, showThought: (text, ms) => thoughts.push({ text, ms }), canShowAmbientBubble: () => true },
    ...extra,
  };
  vm.runInNewContext(SOURCE, {
    window: win,
    URLSearchParams,
    performance: { now: () => clock.t },
    console: { warn() {} },
    setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
    fetch: () => Promise.reject(new Error('no network in tests')),
    Image: class {},
  });
  const sprite = win.PetSprite;
  sprite.useSheet(meta, await player(), {}, walkerOptions);
  const rec = recorder();
  const scratch = recorder();
  let last = 0;
  // Draw at time t, first drawing one frame at a time up to it as the app's animation loop would
  // (the player caps each step at 50 ms, so a single long jump would not move its timers).
  const drawAt = (t, opts = {}, x = 0, y = 0, scale = 6) => {
    while (t - last > FRAME_MS) {
      last += FRAME_MS;
      clock.t = last;
      scratch.calls.length = 0;
      sprite.draw(scratch.ctx, x, y, scale, opts);
    }
    last = t;
    clock.t = t;
    rec.calls.length = 0;
    sprite.draw(rec.ctx, x, y, scale, opts);
    return describe(rec.calls);
  };
  const jump = (t) => { clock.t = t; last = t; };
  return { sprite, clock, timers, thoughts, rec, drawAt, jump };
}

test('standing still with nothing to react to, it idles and blinks', async () => {
  const { drawAt } = await setup();
  drawAt(0);
  assert.strictEqual(drawAt(500).pose, 'idle_side', 'the side-on rest pose right after settling');
  assert.strictEqual(drawAt(2000).pose, 'idle', 'then the front-on idle');
  // rng 0.5 puts the first blink midway through the 2800 to 6500 ms gap
  assert.strictEqual(drawAt(4700).pose, 'blink');
  assert.strictEqual(drawAt(4900).pose, 'idle', 'the blink lasts 140 ms');
});

test('a reaction pose shows as soon as the pet is still, and the default idle pose never overrides one', async () => {
  const { sprite, drawAt } = await setup();
  drawAt(0);
  sprite.setLive('celebrate');
  assert.strictEqual(drawAt(100).pose, 'sunbreak', 'overrides the rest pose at once');
  assert.strictEqual(drawAt(4700).pose, 'sunbreak', 'a blink does not interrupt it');

  sprite.setLive('game_time'); // maps to the plain idle pose
  assert.strictEqual(drawAt(4750).pose, 'blink', 'idle behavior carries on instead of a frozen idle pose');
  sprite.setLive(null);
  assert.strictEqual(drawAt(6000).pose, 'idle');
});

test('the weather pose replaces only ambient reactions', async () => {
  const { sprite, drawAt } = await setup();
  drawAt(0);
  sprite.setWeatherPose('wx_rain');
  sprite.setLive('short_idle');
  assert.strictEqual(drawAt(100).pose, 'wx_rain', 'an ambient reaction shows the weather');
  sprite.setLive(null);
  assert.strictEqual(drawAt(200).pose, 'wx_rain', 'so does having no reaction at all');
  sprite.setLive('celebrate');
  assert.strictEqual(drawAt(300).pose, 'sunbreak', 'an event reaction keeps its own pose');
  sprite.setWeatherPose(null);
  sprite.setLive('short_idle');
  assert.ok(['idle', 'idle_side', 'blink'].includes(drawAt(400).pose), 'without weather it is back to idling');
});

test('a bubble shows its pose at once, holds it, and lets go', async () => {
  const { sprite, drawAt } = await setup();
  drawAt(4700); // the middle of a blink
  sprite.hold('error_spotted');
  assert.strictEqual(drawAt(4700).pose, 'storm', 'over the blink, right away');
  assert.strictEqual(drawAt(4700 + 7900).pose, 'storm');
  assert.notStrictEqual(drawAt(4700 + 8100).pose, 'storm', 'released after the hold');

  drawAt(20000);
  sprite.hold('chat_chatter'); // maps to the plain idle pose
  assert.ok(['idle', 'blink', 'look', 'idle_side'].includes(drawAt(20100).pose), 'no frozen idle pose over the idle behavior');
});

test('asleep, it shows the sleepy pose whatever else is going on', async () => {
  const { sprite, drawAt } = await setup();
  drawAt(0);
  sprite.setLive('celebrate');
  sprite.hold('error_spotted');
  assert.strictEqual(drawAt(100, { sleeping: true }).pose, 'sleepy');
  assert.strictEqual(drawAt(200, { sleeping: false }).pose, 'storm', 'awake again, the bubble pose is back');
});

test('every pose plays within its own frame count, loops wrap and one-shots hold the last frame', async () => {
  const { sprite, timers, thoughts, drawAt, jump } = await setup();
  sprite.startPoseCycle();
  const seen = [];
  for (let i = 0; i < poseNames.length; i += 1) {
    const label = thoughts[thoughts.length - 1].text;
    const name = label.match(/^pose: (\S+) /)[1];
    const frames = meta.poses[name].frames || meta.frameCount;
    assert.ok(label.includes(`(${frames} frames`), `${label} shows its frame count`);
    const startedAt = i * 10000;
    const shown = new Set();
    for (let t = 0; t <= 4000; t += 40) {
      const d = drawAt(startedAt + t);
      assert.strictEqual(d.pose, name);
      assert.ok(d.frame >= 0 && d.frame < frames, `${name} frame ${d.frame} is inside ${frames}`);
      shown.add(d.frame);
    }
    if (meta.poses[name].loop === false) {
      assert.strictEqual(drawAt(startedAt + 4000).frame, frames - 1, `${name} holds its last frame`);
      assert.ok(shown.has(0), `${name} starts at its first frame`);
    } else {
      assert.strictEqual(shown.size, frames, `${name} shows all ${frames} frames`);
    }
    seen.push(name);
    jump((i + 1) * 10000);
    timers[timers.length - 1].fn(); // the cycler moves to the next pose
  }
  assert.deepStrictEqual(seen, poseNames, 'visits every pose in the sheet once');
  sprite.stopPoseCycle();
});

test('drawing is nearest neighbor on the sprite pixel grid', async () => {
  const { rec, sprite, drawAt } = await setup();
  const scale = 6; // sprite pixel = round(0.75 * 6) = 5 screen pixels
  const k = 5;
  for (const x of [0, 1, 2, 7, 101, 333]) {
    const d = drawAt(1000, {}, x, 40, scale);
    assert.strictEqual(d.x % k, 0, `x ${x} lands on the grid`);
    assert.strictEqual(d.size, 16 * k);
  }
  assert.strictEqual(rec.ctx.imageSmoothingEnabled, false);
  assert.strictEqual(sprite.sizeFor(scale), 16 * k);
});

// ---- Facing, turning, dragging and reduced motion ----

const SPEED = 0.5; // the crab's default step in px per frame

// Run the sprite one frame at a time, as the animation loop would, moving it by vx px per frame.
function walk(ctxHolder, { from, ms, vx, opts = {}, x0 = 400 }) {
  const out = [];
  let x = x0;
  for (let t = from + FRAME_MS; t <= from + ms; t += FRAME_MS) {
    x += vx;
    out.push({ t, ...ctxHolder.drawAt(t, { ...opts, vx }, x) });
  }
  return out;
}

test('moving right shows the move pose facing right, with no mirror', async () => {
  const s = await setup();
  s.drawAt(0);
  const frames = walk(s, { from: 0, ms: 1000, vx: SPEED });
  const last = frames[frames.length - 1];
  assert.strictEqual(last.pose, 'move');
  assert.strictEqual(last.mirrored, false);
});

test('moving left plays the turn, then shows the move pose mirrored', async () => {
  const s = await setup();
  s.drawAt(0);
  walk(s, { from: 0, ms: 600, vx: SPEED }); // heading right first
  const frames = walk(s, { from: 600, ms: 1200, vx: -SPEED });
  const poses = frames.map((f) => f.pose);
  assert.ok(poses.includes('turn'), 'the turn animation plays when the direction reverses');
  assert.ok(poses.indexOf('turn') < poses.lastIndexOf('move'), 'the turn comes before the new move');
  const last = frames[frames.length - 1];
  assert.strictEqual(last.pose, 'move');
  assert.strictEqual(last.mirrored, true, 'facing left is the mirrored sprite');
});

test('reversing mid-turn never snaps: the turn frame moves one step at a time', async () => {
  const s = await setup();
  s.drawAt(0);
  walk(s, { from: 0, ms: 600, vx: SPEED });
  const turnSeq = [];
  let t = 600;
  const flips = [-SPEED, -SPEED, -SPEED, SPEED, SPEED, SPEED, -SPEED, -SPEED, -SPEED, -SPEED, -SPEED, -SPEED, -SPEED];
  for (const vx of flips) {
    t += FRAME_MS;
    const d = s.drawAt(t, { vx }, 400);
    if (d.pose === 'turn') turnSeq.push(d.frame);
  }
  assert.ok(turnSeq.length >= 3, 'the turn was playing');
  for (let i = 1; i < turnSeq.length; i += 1) {
    assert.ok(Math.abs(turnSeq[i] - turnSeq[i - 1]) <= 1, `turn frames ${turnSeq[i - 1]} then ${turnSeq[i]} do not jump`);
  }
});

test('when it stops it rests side-on facing the way it was going, then goes back to idle', async () => {
  const s = await setup();
  s.drawAt(0);
  walk(s, { from: 0, ms: 600, vx: SPEED });
  walk(s, { from: 600, ms: 1200, vx: -SPEED }); // now facing left
  const settled = s.drawAt(1800 + 300, { vx: 0 });
  assert.strictEqual(settled.pose, 'idle_side');
  assert.strictEqual(settled.mirrored, true, 'still facing left');
  assert.strictEqual(s.drawAt(1800 + 2200, { vx: 0 }).pose, 'idle', 'after a moment, the front-on idle');
});

test('a reaction pose shows when the pet stands still but not while it walks, and a bubble shows either way', async () => {
  const s = await setup();
  s.sprite.setLive('celebrate');
  s.drawAt(0);
  assert.strictEqual(walk(s, { from: 0, ms: 600, vx: SPEED }).pop().pose, 'move', 'walking, the pose is the move pose');
  assert.strictEqual(s.drawAt(1500, { vx: 0 }).pose, 'sunbreak', 'standing, the reaction shows');
  s.sprite.hold('error_spotted');
  assert.strictEqual(walk(s, { from: 1500, ms: 300, vx: SPEED }).pop().pose, 'storm', 'a bubble shows even while walking');
});

test('dragging shows the move pose facing the drag, even when the cursor pauses, and rests on release', async () => {
  const s = await setup();
  s.drawAt(0);
  walk(s, { from: 0, ms: 600, vx: -3, opts: { dragging: true } }); // dragged left
  const paused = s.drawAt(700, { dragging: true, vx: 0 });
  assert.strictEqual(paused.pose, 'move', 'the move pose while held, even with no motion');
  assert.strictEqual(paused.mirrored, true, 'facing the way it was dragged');
  const moving = walk(s, { from: 700, ms: 400, vx: 3, opts: { dragging: true } });
  assert.ok(moving.some((f) => f.pose === 'turn') || moving[moving.length - 1].mirrored === false, 'dragging the other way turns it around');
  assert.strictEqual(moving[moving.length - 1].pose, 'move');
  assert.strictEqual(moving[moving.length - 1].mirrored, false);

  const released = s.drawAt(1100 + 300, { dragging: false, vx: 0 });
  assert.strictEqual(released.pose, 'idle_side', 'on release it goes to the rest pose');
  assert.strictEqual(s.drawAt(1100 + 2200, { vx: 0 }).pose, 'idle', 'then idle');
});

test('facing left is the mirror with the manifest offset, at the same grid position as facing right', async () => {
  const k = 5; // Size 6 gives 5 screen pixels per sprite pixel
  const still = async (vx) => {
    const s = await setup();
    s.drawAt(0);
    if (vx < 0) for (let t = FRAME_MS; t <= 600; t += FRAME_MS) s.drawAt(t, { vx: -vx }, 400); // face right first
    let last = null;
    for (let t = 600 + FRAME_MS; t <= 1800; t += FRAME_MS) last = s.drawAt(t, { vx }, 400); // the pet itself stays at x 400
    return last;
  };
  const right = await still(SPEED);
  const left = await still(-SPEED);
  assert.strictEqual(right.pose, 'move');
  assert.strictEqual(left.pose, 'move');
  assert.strictEqual(right.mirrored, false);
  assert.strictEqual(left.mirrored, true);
  assert.strictEqual(right.x, 400, 'facing right is drawn at the grid position');
  // The mirrored draw is translated by the frame width plus the manifest offset, so its silhouette
  // covers the same columns the sheet was built for.
  assert.strictEqual(meta.facing.mirrorOffsetPx, 1);
  assert.strictEqual(left.x, 400 + (16 + meta.facing.mirrorOffsetPx) * k);
  assert.strictEqual(left.size, right.size);
});

test('reduced motion: still poses, no walking poses, and the setting can be flipped live', async () => {
  const s = await setup();
  s.sprite.setReducedMotionPref(true);
  assert.strictEqual(s.sprite.reducedMotion(), true);
  s.drawAt(0);
  const frames = walk(s, { from: 0, ms: 800, vx: SPEED });
  for (const f of frames) {
    assert.ok(f.pose !== 'move' && f.pose !== 'turn', `${f.pose} is not a moving pose`);
    assert.strictEqual(f.frame, 0, 'always the first frame');
    assert.strictEqual(f.mirrored, false);
  }
  s.sprite.setLive('celebrate');
  const reaction = s.drawAt(1500, { vx: 0 });
  assert.strictEqual(reaction.pose, 'sunbreak');
  assert.strictEqual(reaction.frame, 0, 'even a reaction pose holds still');

  s.sprite.setReducedMotionPref(false);
  assert.strictEqual(s.sprite.reducedMotion(), false);
  assert.strictEqual(walk(s, { from: 1500, ms: 600, vx: SPEED }).pop().pose, 'move', 'back to normal at once');
});

test('reduced motion follows the system setting until a choice is made', async () => {
  const listeners = [];
  const query = { matches: true, addEventListener: (type, cb) => listeners.push(cb) };
  const s = await setup({ extra: { matchMedia: () => query } });
  assert.strictEqual(s.sprite.reducedMotion(), true, 'the system says reduce');
  query.matches = false;
  listeners.forEach((cb) => cb({ matches: false }));
  assert.strictEqual(s.sprite.reducedMotion(), false, 'follows the system when it changes');
  s.sprite.setReducedMotionPref(true);
  listeners.forEach((cb) => cb({ matches: false }));
  assert.strictEqual(s.sprite.reducedMotion(), true, 'an explicit choice wins over the system');
  s.sprite.setReducedMotionPref(null);
  assert.strictEqual(s.sprite.reducedMotion(), false, 'clearing the choice goes back to the system');
});

test('the saved preference reaches the sprite from the prefs the app sends', async () => {
  let onPrefs = null;
  const s = await setup({
    extra: { crabAPI: { getPrefs: () => Promise.resolve({ petReduceMotion: true }), onPrefsUpdated: (cb) => { onPrefs = cb; } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(s.sprite.reducedMotion(), true, 'the saved value is read at start');
  onPrefs({ petReduceMotion: false });
  assert.strictEqual(s.sprite.reducedMotion(), false, 'a change in Preferences applies live');
  onPrefs({ skin: 'royal' });
  assert.strictEqual(s.sprite.reducedMotion(), false, 'unrelated changes leave it alone');
});
