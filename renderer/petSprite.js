// Raincloud pet sprite (ml-pet-brain branch). Draws the raincloud in place of the crab,
// but only when main loaded the page with ?petbrain=1, which happens only when the pet
// brain is active (PET_BRAIN_LOCAL=1). Otherwise this file does nothing.
//
// Everything lives inside this function so it cannot collide with the globals that
// crab.js and chat.js share.
(function () {
  'use strict';

  const FRAME = 16; // raincloud.json frameSize; kept here so sizeFor() works before the sheet loads
  const HOLD_MS = 8000; // how long a bubble's pose stays up
  const CYCLE_MS = 2500; // debug pose cycler
  const BUBBLE_MS = 7000; // how long a line stays in the bubble
  const RETRY_MS = 1000; // while something else is on screen, check again this often
  const RETRY_FOR_MS = 20000; // then give up on the line

  const params = new URLSearchParams(window.location.search);

  let meta = null;
  let cloud = null;
  let ready = false;
  let liveReaction = null; // follows the rules, set by main
  let held = null;         // { reaction, until } while a bubble is up
  let weatherPose = null;  // set by the weather feature
  let cycle = null;        // { poses, index, timer } while the debug cycler runs
  let pendingBubble = null; // { reaction, line, giveUpAt } waiting for a free moment
  let retryTimer = null;
  const debugClouds = new Map();

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

  function cloudForPose(pose, createRaincloud, image) {
    if (!debugClouds.has(pose)) {
      debugClouds.set(pose, createRaincloud({ ...meta, reactions: { ...meta.reactions, __debug: pose } }, image));
    }
    return debugClouds.get(pose);
  }

  let makeCloud = null; // set in init: (pose) => raincloud that always shows that pose

  function draw(ctx, x, y, scale, opts) {
    if (!ready) return;
    const k = pixelScale(scale);
    const px = Math.round(x);
    const py = Math.round(y);
    const now = performance.now();
    if (cycle) {
      makeCloud(cycle.poses[cycle.index]).draw(ctx, '__debug', px, py, k, now, null);
      return;
    }
    let reaction = liveReaction || 'idle';
    if (held && now < held.until) reaction = held.reaction;
    if (opts && opts.sleeping) reaction = 'goodnight';
    cloud.draw(ctx, reaction, px, py, k, now, weatherPose);
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

  function stopCycle() {
    if (cycle) {
      clearInterval(cycle.timer);
      cycle = null;
    }
  }

  function startCycle() {
    if (!ready || cycle) return;
    const poses = Object.keys(meta.poses);
    cycle = { poses, index: 0, timer: null };
    say('pose: ' + poses[0], CYCLE_MS);
    cycle.timer = setInterval(() => {
      cycle.index = (cycle.index + 1) % cycle.poses.length;
      say('pose: ' + cycle.poses[cycle.index], CYCLE_MS);
    }, CYCLE_MS);
  }

  const api = {
    wanted: params.get('petbrain') === '1',
    isReady: () => ready,
    sizeFor: (scale) => FRAME * pixelScale(scale),
    draw,
    setLive(reaction) { liveReaction = typeof reaction === 'string' ? reaction : null; },
    hold(reaction, ms) {
      if (typeof reaction === 'string') held = { reaction, until: performance.now() + (ms || HOLD_MS) };
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
        fetch('raincloud/raincloud.json').then((r) => r.json()),
        import('./raincloud/raincloud.js'),
        loadImage('raincloud/raincloud.png'),
      ]);
      meta = metaJson;
      cloud = mod.createRaincloud(meta, image);
      makeCloud = (pose) => cloudForPose(pose, mod.createRaincloud, image);
      ready = true;
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
