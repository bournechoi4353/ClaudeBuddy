// Drizzle, the raincloud pet sprite (v2 sheet). Draws the raincloud in place of the crab,
// but only when main loaded the page with ?petbrain=1, which happens only when the pet
// brain is active (PET_BRAIN_LOCAL=1). Otherwise this file does nothing.
//
// Poses come from the sheet's manifest through pet.poseFor(reaction, weatherPose). The player's
// walker supplies the idle behavior (blinks and glances) and the pose for the live reaction while
// the pet stands still. A bubble's pose is drawn over that right away.
//
// Everything lives inside this function so it cannot collide with the globals that
// crab.js and chat.js share.
(function () {
  'use strict';

  const FRAME = 16; // frameSize in the manifest; kept here so sizeFor() works before the sheet loads
  const HOLD_MS = 8000; // how long a bubble's pose stays up
  const CYCLE_MS = 2500; // debug pose cycler, minimum time on each pose
  const BUBBLE_MS = 7000; // how long a line stays in the bubble
  const RETRY_MS = 1000; // while something else is on screen, check again this often
  const RETRY_FOR_MS = 20000; // then give up on the line

  const params = new URLSearchParams(window.location.search);

  let meta = null;
  let pet = null;           // createRaincloud(meta, image)
  let walker = null;        // createWalker(pet, ...)
  let ready = false;
  let liveReaction = null;  // follows the rules, set by main
  let held = null;          // { reaction, startedAt, until } while a bubble is up
  let weatherPose = null;   // set by the weather feature
  let walkerKey = '';       // the reaction and weather pose last given to the walker
  let cycle = null;         // { entries, index, startedAt, timer } while the debug cycler runs
  let pendingBubble = null; // { reaction, line, giveUpAt } waiting for a free moment
  let retryTimer = null;

  // Whole-number pixel scale for the sprite, sized to match the crab at the same Size setting.
  function pixelScale(scale) {
    return Math.max(1, Math.round(scale * 0.75));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('could not load ' + src));
      img.src = src;
    });
  }

  function draw(ctx, x, y, scale, opts) {
    if (!ready) return;
    const k = pixelScale(scale);
    // Draw on the sprite pixel grid: every sprite pixel lands as exactly k screen pixels.
    const px = Math.round(Math.round(x) / k) * k;
    const py = Math.round(y);
    const now = performance.now();
    if (cycle) {
      const e = cycle.entries[cycle.index];
      pet.drawFrame(ctx, e.name, pet.frameAt(e.name, now, cycle.startedAt), px, py, k, e.mirrored);
      return;
    }

    const sleeping = !!(opts && opts.sleeping);
    // With no live reaction the pet is in the plain 'idle' state, which is an ambient reaction, so the weather pose shows.
    const reaction = sleeping ? 'goodnight' : (liveReaction || 'idle');
    const key = reaction + '|' + weatherPose;
    if (key !== walkerKey) {
      walkerKey = key;
      walker.setReaction(reaction, weatherPose);
    }
    const cur = walker.update(now);

    // A bubble's pose shows at once, over a blink or a glance. A reaction that maps to the default
    // idle pose is not drawn over anything: the idle behavior (blinks, glances) carries on instead.
    if (!sleeping && held && now < held.until) {
      const name = pet.poseFor(held.reaction, weatherPose);
      if (name !== meta.defaultPose) {
        pet.drawFrame(ctx, name, pet.frameAt(name, now, held.startedAt), px, py, k, false);
        return;
      }
    }
    pet.drawFrame(ctx, cur.pose, cur.frame, px, py, k, cur.mirrored);
  }

  function say(text, ms) {
    if (window.Crab && window.Crab.showThought) window.Crab.showThought(text, ms);
  }

  // Show the line in the crab's existing thought bubble, unless something else is using it
  // (a timer alert, another bubble, chat open, asleep). If so, retry briefly, then drop it.
  function tryShowBubble() {
    if (!pendingBubble) return;
    const crab = window.Crab;
    if (performance.now() > pendingBubble.giveUpAt || !crab || !crab.canShowAmbientBubble) {
      pendingBubble = null;
    } else if (crab.canShowAmbientBubble()) {
      crab.showThought(pendingBubble.line, BUBBLE_MS);
      api.hold(pendingBubble.reaction, HOLD_MS);
      pendingBubble = null;
    }
    if (!pendingBubble && retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }
  }

  function queueBubble(info) {
    if (!info || typeof info.line !== 'string' || !info.line) return;
    pendingBubble = { reaction: info.reaction, line: info.line, giveUpAt: performance.now() + RETRY_FOR_MS };
    tryShowBubble();
    if (pendingBubble && !retryTimer) retryTimer = setInterval(tryShowBubble, RETRY_MS);
  }

  // ---- Hidden pose cycler (tray: "Pet brain: cycle all poses") ----

  function cycleLabel(entry) {
    return `pose: ${entry.name} (${pet.framesOf(entry.name)} frames${entry.mirrored ? ', mirrored' : ''})`;
  }

  // Looping poses stay up for CYCLE_MS. One-shot poses (turn, look) stay long enough to play once and then hold.
  function cycleDwell(entry) {
    const p = meta.poses[entry.name];
    if (p.loop === false) return Math.max(CYCLE_MS, (pet.framesOf(entry.name) / p.fps) * 1000 + 800);
    return CYCLE_MS;
  }

  function stopCycle() {
    if (cycle) {
      clearTimeout(cycle.timer);
      cycle = null;
    }
  }

  function startCycle() {
    if (!ready || cycle) return;
    cycle = { entries: Object.keys(meta.poses).map((name) => ({ name, mirrored: false })), index: 0, startedAt: 0, timer: null };
    const show = () => {
      const entry = cycle.entries[cycle.index];
      cycle.startedAt = performance.now();
      say(cycleLabel(entry), cycleDwell(entry));
      cycle.timer = setTimeout(() => {
        if (!cycle) return;
        cycle.index = (cycle.index + 1) % cycle.entries.length;
        show();
      }, cycleDwell(entry));
    };
    show();
  }

  // Load a sheet: its manifest, the player module and the image. init() calls this; tests call it with stand-ins.
  function useSheet(sheetMeta, mod, image, walkerOptions) {
    meta = sheetMeta;
    pet = mod.createRaincloud(meta, image);
    walker = mod.createWalker(pet, walkerOptions);
    walkerKey = '';
    ready = true;
  }

  const api = {
    wanted: params.get('petbrain') === '1',
    isReady: () => ready,
    sizeFor: (scale) => FRAME * pixelScale(scale),
    draw,
    useSheet,
    setLive(reaction) { liveReaction = typeof reaction === 'string' ? reaction : null; },
    hold(reaction, ms) {
      if (typeof reaction === 'string') {
        const now = performance.now();
        held = { reaction, startedAt: now, until: now + (ms || HOLD_MS) };
      }
    },
    setWeatherPose(pose) { weatherPose = typeof pose === 'string' ? pose : null; },
    startPoseCycle: startCycle,
    stopPoseCycle: stopCycle,
  };
  window.PetSprite = api;

  async function init() {
    if (!api.wanted) return;
    try {
      const [metaJson, mod, image] = await Promise.all([
        fetch('raincloud/raincloud_v2.json').then((r) => r.json()),
        import('./raincloud/raincloud_v2.js'),
        loadImage('raincloud/raincloud_v2.png'),
      ]);
      useSheet(metaJson, mod, image);
    } catch (err) {
      // Could not load the sheet: give the crab back rather than leave an empty screen.
      console.warn('[pet-brain] raincloud failed to load, using the crab:', err && err.message);
      api.wanted = false;
    }
    if (window.Crab && window.Crab.refreshSize) window.Crab.refreshSize();
  }

  if (window.crabAPI) {
    if (window.crabAPI.onPetState) {
      window.crabAPI.onPetState((info) => { if (info) api.setLive(info.reaction); });
    }
    if (window.crabAPI.onPetBubble) {
      window.crabAPI.onPetBubble(queueBubble);
    }
    if (window.crabAPI.onPetWeather) {
      window.crabAPI.onPetWeather((info) => api.setWeatherPose(info ? info.pose : null));
    }
    if (window.crabAPI.onPetDebug) {
      window.crabAPI.onPetDebug((info) => {
        if (info && info.cycle) startCycle(); else stopCycle();
      });
    }
  }

  init();
})();
