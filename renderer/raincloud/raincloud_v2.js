// raincloud_v2.js: canvas player for Drizzle (raincloud_v2.png + raincloud_v2.json). ES module, renderer or browser.
//
//   import meta from './raincloud_v2.json' with { type: 'json' };
//   const img = new Image(); img.src = './raincloud_v2.png'; await img.decode();
//   const pet = createRaincloud(meta, img);
//
// 1) Reaction poses (same idea as v1): pet.draw(ctx, 'celebrate', x, y, scale, performance.now(), weatherPose)
//
// 2) Walking pet with facing, turning, glances and blinks:
//   const walker = createWalker(pet, { x: 100 });
//   walker.setTarget(400);                         // it floats there, facing right
//   walker.setReaction('celebrate', weatherPose);  // optional; applies only while standing still
//   each frame: walker.update(performance.now()); walker.draw(ctx, y, scale);
//
// Rules baked in:
//   - Directional poses are drawn facing RIGHT. Facing left is a horizontal mirror (+1 sprite px offset).
//   - Turning plays the 5-frame 'turn' pose (left-facing to right-facing, reversed for right to left).
//     Reversing mid-turn simply runs it backwards from where it is, so it never snaps.
//   - Motion is time-based with acceleration and deceleration, drawn on the sprite-pixel grid (no shimmer).
//   - prefers-reduced-motion: pass { reducedMotion: true } to freeze on a still pose and teleport.

export function createRaincloud(meta, img) {
  const S = meta.frameSize;
  const framesOf = (p) => p.frames || meta.frameCount;
  const off = (meta.facing && meta.facing.mirrorOffsetPx) || 0;
  const pet = {
    meta,
    framesOf(name) { return framesOf(meta.poses[name]); },
    poseFor(reaction, weatherPose) {
      if (weatherPose && meta.poses[weatherPose] && meta.ambientReactions.includes(reaction)) return weatherPose;
      return meta.reactions[reaction] || meta.defaultPose;
    },
    // Frame index for a pose at a time. Looping poses wrap; one-shot poses (loop:false) hold their last frame.
    frameAt(name, timeMs, startMs = 0) {
      const p = meta.poses[name], n = framesOf(p);
      const k = Math.floor(((timeMs - startMs) / 1000) * p.fps);
      return p.loop === false ? Math.max(0, Math.min(k, n - 1)) : ((k % n) + n) % n;
    },
    drawFrame(ctx, name, frame, x, y, scale, mirrored = false) {
      const p = meta.poses[name];
      ctx.imageSmoothingEnabled = false;
      if (!mirrored) {
        ctx.drawImage(img, frame * S, p.row * S, S, S, x, y, S * scale, S * scale);
        return;
      }
      ctx.save();
      ctx.translate(x + (S + off) * scale, y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, frame * S, p.row * S, S, S, 0, 0, S * scale, S * scale);
      ctx.restore();
    },
    draw(ctx, reaction, x, y, scale, timeMs, weatherPose) {
      const name = this.poseFor(reaction, weatherPose);
      this.drawFrame(ctx, name, this.frameAt(name, timeMs), x, y, scale, false);
    },
  };
  return pet;
}

export function createWalker(pet, opts = {}) {
  const m = pet.meta;
  const F = m.facing, B = m.blink, G = m.glance;
  const rng = opts.rng || Math.random;
  const cfg = Object.assign({
    maxSpeed: 90,        // screen px per second
    accel: 320,          // screen px per second squared
    easeDist: 3,         // desired speed = distance * easeDist, capped at maxSpeed (smooth arrival)
    moveThreshold: 10,   // below this speed it counts as standing still
    restMs: 1400,        // how long it keeps the side-on resting pose after stopping
    snapScale: true,     // draw on the sprite-pixel grid
    reducedMotion: false,
  }, opts);

  const turnN = pet.framesOf(F.turnPose);
  const turnSecs = turnN / m.poses[F.turnPose].fps;
  const lookSecs = pet.framesOf(G.pose) / m.poses[G.pose].fps;
  const between = (a, b) => a + rng() * (b - a);

  const st = {
    x: opts.x || 0, v: 0, target: opts.x || 0,
    p: 1, goal: 1,                 // turn progress: 0 = faces left, 1 = faces right
    stillMs: 0, last: null,
    reactionPose: null,
    blinkUntil: 0, nextBlink: null,
    glanceStart: null, nextGlance: null,
    cur: { pose: m.defaultPose, frame: 0, mirrored: false },
  };

  function update(now) {
    if (st.last === null) {
      st.last = now;
      st.nextBlink = now + between(B.minGapMs, B.maxGapMs);
      st.nextGlance = now + between(G.minGapMs, G.maxGapMs);
    }
    const dt = Math.min(0.05, Math.max(0, (now - st.last) / 1000));
    st.last = now;

    // movement: accelerate toward a distance-limited desired speed
    const dist = st.target - st.x;
    if (cfg.reducedMotion) { st.x = st.target; st.v = 0; }
    else {
      const desired = Math.abs(dist) < 0.5 ? 0 : Math.sign(dist) * Math.min(cfg.maxSpeed, Math.abs(dist) * cfg.easeDist);
      const dv = desired - st.v, maxDv = cfg.accel * dt;
      st.v += Math.abs(dv) <= maxDv ? dv : Math.sign(dv) * maxDv;
      st.x += st.v * dt;
      if (Math.abs(st.target - st.x) < 0.5 && Math.abs(st.v) < 4) { st.x = st.target; st.v = 0; }
    }
    const moving = Math.abs(st.v) > cfg.moveThreshold;

    // facing: head the way it travels; the turn plays through p
    if (moving) st.goal = st.v > 0 ? 1 : 0;
    const step = dt / turnSecs;
    if (st.p < st.goal) st.p = Math.min(st.goal, st.p + step);
    else if (st.p > st.goal) st.p = Math.max(st.goal, st.p - step);
    const turning = st.p !== st.goal && !cfg.reducedMotion;
    if (cfg.reducedMotion) st.p = st.goal;
    const facingRight = st.p >= 0.5;

    st.stillMs = moving ? 0 : st.stillMs + dt * 1000;

    let cur;
    if (turning) {
      cur = { pose: F.turnPose, frame: Math.round(st.p * (turnN - 1)), mirrored: false };
      st.glanceStart = null;
    } else if (moving) {
      cur = { pose: F.movePose, frame: pet.frameAt(F.movePose, now), mirrored: !facingRight };
      st.glanceStart = null;
    } else if (st.reactionPose) {
      cur = { pose: st.reactionPose, frame: pet.frameAt(st.reactionPose, now), mirrored: false };
      st.glanceStart = null;
    } else if (cfg.reducedMotion) {
      cur = { pose: m.defaultPose, frame: 0, mirrored: false };
    } else if (st.stillMs < cfg.restMs) {
      cur = { pose: F.restPose, frame: pet.frameAt(F.restPose, now), mirrored: !facingRight };
    } else {
      // settled idle: occasional glance (looks right, then left) and blinks
      if (st.glanceStart === null && now >= st.nextGlance) st.glanceStart = now;
      if (st.glanceStart !== null && now - st.glanceStart >= lookSecs * 1000) {
        st.glanceStart = null; st.nextGlance = now + between(G.minGapMs, G.maxGapMs);
      }
      if (st.glanceStart !== null) {
        cur = { pose: G.pose, frame: pet.frameAt(G.pose, now, st.glanceStart), mirrored: false };
      } else {
        if (now >= st.nextBlink) { st.blinkUntil = now + B.durationMs; st.nextBlink = now + between(B.minGapMs, B.maxGapMs); }
        const idleFrame = pet.frameAt(B.basePose, now);
        cur = { pose: now < st.blinkUntil ? B.blinkPose : B.basePose, frame: idleFrame, mirrored: false };
      }
    }
    st.cur = cur;
    return cur;
  }

  return {
    state: st,
    setTarget(x) { st.target = x; },
    // reaction pose overrides only while standing still; the default idle pose never overrides
    setReaction(reaction, weatherPose) {
      if (!reaction) { st.reactionPose = null; return; }
      const name = pet.poseFor(reaction, weatherPose);
      st.reactionPose = name === m.defaultPose ? null : name;
    },
    update,
    draw(ctx, y, scale) {
      const c = st.cur;
      const px = cfg.snapScale ? Math.round(st.x / scale) * scale : st.x;
      pet.drawFrame(ctx, c.pose, c.frame, px, y, scale, c.mirrored);
    },
  };
}
