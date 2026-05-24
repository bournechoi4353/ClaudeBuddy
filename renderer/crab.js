// Phase 3: animation + hit-testing for click-through.
// Animation logic from Phase 2 unchanged; added a mouse-region machine
// that toggles win.setIgnoreMouseEvents based on whether the cursor
// is over the crab or the chat panel.

const CRAB = [
  '..OOOOOOOO..',
  '..OXOOOOXO..',
  '..OOOOOOOO..',
  'OOOOOOOOOOOO',
  'OOOOOOOOOOOO',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..OOOOOOOO..',
  '..O.O..O.O..',
  '..O.O..O.O..',
];

const COLORS = {
  O: '#CC785C', // body — live-updated from prefs window / skin selection
  X: '#000000', // eyes — live-updated from skin selection
};

// Skin presets. Each picks a body + eye color, optionally a permanent
// accessory drawn on top of the crab. "custom" means: defer to prefs.crabColor
// for the body so the user's color-picker choice wins.
const SKINS = {
  default:    { body: '#CC785C', eye: '#000000' },
  hacker:     { body: '#1AAF5D', eye: '#000000', accessory: 'glasses' },
  ghost:      { body: '#F5F5F5', eye: '#555555' },
  sushi:      { body: '#E8769A', eye: '#000000' },
  royal:      { body: '#7B5BAD', eye: '#000000', accessory: 'crown', accessoryColor: '#FFD700' },
  boba:       { body: '#D4A574', eye: '#4A2C1A' },
  cyberpunk:  { body: '#FF1493', eye: '#00FFFF' },
  shadow:     { body: '#2C2C2C', eye: '#FF6B35' },
};

let currentSkinAccessory = null;
let currentSkinAccessoryColor = null;

// Initial scale read from URL params at load time so we don't render at the
// default and then jump when the IPC arrives.
const _initParams = new URLSearchParams(window.location.search);
let SCALE = parseInt(_initParams.get('scale') || '6', 10) || 6;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const cols = CRAB[0].length;
const rows = CRAB.length;
let crabW = cols * SCALE;
let crabH = rows * SCALE;

function applyScale(newScale) {
  if (typeof newScale !== 'number' || newScale < 1) return;
  SCALE = newScale;
  crabW = cols * SCALE;
  crabH = rows * SCALE;
  if (posX + crabW > canvas.width) posX = Math.max(0, canvas.width - crabW);
  if (posX < 0) posX = 0;
}

if (window.crabAPI && window.crabAPI.onSetScale) {
  window.crabAPI.onSetScale((info) => {
    if (info) applyScale(info.scale);
  });
}

// Live preference application — pulled at startup, also pushed when the user
// edits the Preferences window. Only visual prefs are applied here; personality
// + pet name take effect on the next chat (agent.js rebuilds the system prompt).
function applyPrefs(p) {
  if (!p) return;
  if (typeof p.crabSpeed === 'number' && p.crabSpeed > 0) SPEED = p.crabSpeed;
  if (typeof p.sleepMinutes === 'number' && p.sleepMinutes > 0) {
    SLEEP_AFTER_MS = p.sleepMinutes * 60 * 1000;
  }
  // Skin selection drives both body and eye colors AND any permanent accessory.
  // "custom" (or unset) defers to prefs.crabColor for the body and keeps eyes black.
  const skinId = p.skin || 'custom';
  const skin = SKINS[skinId];
  if (skin) {
    COLORS.O = skin.body;
    COLORS.X = skin.eye || '#000000';
    currentSkinAccessory = skin.accessory || null;
    currentSkinAccessoryColor = skin.accessoryColor || null;
  } else {
    // custom — body driven by color picker, eyes always black, no permanent accessory.
    if (typeof p.crabColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(p.crabColor)) {
      COLORS.O = p.crabColor;
    }
    COLORS.X = '#000000';
    currentSkinAccessory = null;
    currentSkinAccessoryColor = null;
  }
}
if (window.crabAPI && window.crabAPI.getPrefs) {
  window.crabAPI.getPrefs().then(applyPrefs).catch(() => {});
}
if (window.crabAPI && window.crabAPI.onPrefsUpdated) {
  window.crabAPI.onPrefsUpdated(applyPrefs);
}

// Initial position: random somewhere across the bottom strip, random
// direction. Beats always-spawning-at-the-left-edge.
let posX = canvas.width > 0
  ? Math.floor(Math.random() * Math.max(0, canvas.width - 200))
  : 0;
let dir = Math.random() < 0.5 ? -1 : 1;
let SPEED = 0.5; // live-updated from prefs window
let externallyPaused = false; // chat open

function fitCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // Clamp Clawd into the new bounds in case the window just moved to a
  // different-sized monitor.
  if (posX + crabW > canvas.width) posX = Math.max(0, canvas.width - crabW);
  if (posX < 0) posX = 0;
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

let walkFrame = 0;
let lastStep = 0;
const STEP_MS = 220;

// Behavior state machine — gives Clawd unpredictable personality instead of
// just bouncing left/right forever. Each state has a duration; on expiry the
// next state is picked probabilistically.
const ST = {
  WALK: 'walk',           // moves at SPEED in dir
  SCUTTLE: 'scuttle',     // moves at 2x SPEED, faster leg cycle
  IDLE: 'idle',           // stands still, planted legs, looking around (blinks)
  STRETCH: 'stretch',     // tiny upward bob arc, no horizontal movement
  BOUNCE_PAUSE: 'bounce', // brief pause after hitting an outer wall
};
let behaviorState = ST.WALK;
let stateStartedAt = performance.now();
let stateUntil = performance.now() + 3000;

function setState(state, durationMs) {
  behaviorState = state;
  stateStartedAt = performance.now();
  stateUntil = stateStartedAt + durationMs;
}

function pickNextBehavior() {
  // Returning from a stop: resume walking, sometimes flipped.
  if (
    behaviorState === ST.IDLE ||
    behaviorState === ST.STRETCH ||
    behaviorState === ST.BOUNCE_PAUSE
  ) {
    if (Math.random() < 0.35) dir = -dir;
    setState(ST.WALK, 4000 + Math.random() * 6000);
    return;
  }
  if (behaviorState === ST.SCUTTLE) {
    setState(ST.WALK, 3000 + Math.random() * 4000);
    return;
  }
  // From WALK, pick a new mood.
  const r = Math.random();
  if (r < 0.25)      setState(ST.IDLE,    1500 + Math.random() * 3000);
  else if (r < 0.35) setState(ST.STRETCH, 700  + Math.random() * 400);
  else if (r < 0.45) setState(ST.SCUTTLE, 1500 + Math.random() * 2000);
  else {
    if (Math.random() < 0.25) dir = -dir; // sometimes turn around mid-stride
    setState(ST.WALK, 2000 + Math.random() * 4000);
  }
}

function stateSpeed() {
  if (behaviorState === ST.WALK) return SPEED;
  if (behaviorState === ST.SCUTTLE) return SPEED * 2;
  return 0;
}

function stateStepMs() {
  if (behaviorState === ST.SCUTTLE) return Math.floor(STEP_MS / 2);
  return STEP_MS;
}

function stateIsMoving() {
  return behaviorState === ST.WALK || behaviorState === ST.SCUTTLE;
}

let eyesClosed = false;
let nextBlink = 0;
let blinkUntil = 0;
function scheduleBlink(t) {
  nextBlink = t + 2500 + Math.random() * 3500;
}
scheduleBlink(performance.now());

// Sleep — after N ms of no chat interaction, Clawd dozes off.
// Backed by prefs.sleepMinutes; live-updated from the Preferences window.
let SLEEP_AFTER_MS = 3 * 60 * 1000;
let lastInteractionAt = performance.now();
let isSleeping = false;
function noteInteraction() {
  lastInteractionAt = performance.now();
  isSleeping = false;
  zParticles.length = 0; // clear floating z's on wake
}

// Floating "Z" particles emitted while sleeping. Each rises and fades.
const Z_GRID = ['###', '..#', '.#.', '#..', '###'];
const zParticles = [];
let lastZSpawnAt = 0;
const Z_SPAWN_INTERVAL_MS = 1400;
const Z_LIFE_MS = 2600;

function spawnZIfSleeping(now) {
  if (!isSleeping) return;
  if (now - lastZSpawnAt < Z_SPAWN_INTERVAL_MS) return;
  const bbox = currentBbox();
  zParticles.push({
    x: bbox.x + bbox.w * 0.65 + (Math.random() - 0.5) * SCALE,
    y: bbox.y - SCALE,
    vx: (Math.random() - 0.3) * 0.015 * SCALE,
    vy: -0.025 * SCALE,
    age: 0,
  });
  lastZSpawnAt = now + Math.random() * 600;
}

function updateZParticles(dtMs) {
  for (let i = zParticles.length - 1; i >= 0; i--) {
    const p = zParticles[i];
    p.age += dtMs;
    if (p.age >= Z_LIFE_MS) {
      zParticles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dtMs;
    p.y += p.vy * dtMs;
  }
}

function drawZParticles() {
  if (zParticles.length === 0) return;
  const pixelSize = Math.max(2, Math.floor(SCALE / 2));
  ctx.fillStyle = COLORS.X;
  for (const p of zParticles) {
    const t = p.age / Z_LIFE_MS;
    let alpha;
    if (t < 0.15) alpha = t / 0.15;
    else if (t > 0.7) alpha = (1 - t) / 0.3;
    else alpha = 1;
    ctx.globalAlpha = alpha;
    for (let r = 0; r < Z_GRID.length; r++) {
      for (let c = 0; c < Z_GRID[r].length; c++) {
        if (Z_GRID[r][c] === '#') {
          ctx.fillRect(Math.floor(p.x) + c * pixelSize, Math.floor(p.y) + r * pixelSize, pixelSize, pixelSize);
        }
      }
    }
  }
  ctx.globalAlpha = 1;
}

// Accessories — overlay pixel art (glasses, headphones, etc.) toggled by
// tool-use events streaming from the agent.
let accessory = null;
let accessoryUntil = 0;
function setAccessory(type, durationMs) {
  accessory = type;
  accessoryUntil = performance.now() + (durationMs || 12000);
}
function clearAccessory() {
  accessory = null;
  accessoryUntil = 0;
}
function handleToolUse(name) {
  if (!name) return;
  if (name.includes('see_screen') || name.includes('see_window')) setAccessory('glasses');
  else if (name.includes('spotify_')) setAccessory('headphones');
  else if (name.includes('frontmost_window')) setAccessory('glasses');
}

const ACCESSORY_CELLS = {
  glasses: [
    // Left lens around eye (col 3, row 1)
    [2, 0], [3, 0], [4, 0],
    [2, 1], [4, 1],
    [2, 2], [3, 2], [4, 2],
    // Bridge between lenses
    [5, 1], [6, 1],
    // Right lens around eye (col 8, row 1)
    [7, 0], [8, 0], [9, 0],
    [7, 1], [9, 1],
    [7, 2], [8, 2], [9, 2],
  ],
  headphones: [
    // Band across top of head
    [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0],
    // Ear cups (one cell outside the body on each side)
    [1, 1], [1, 2],
    [10, 1], [10, 2],
  ],
  crown: [
    // Band resting on top of his head
    [3, -1], [4, -1], [5, -1], [6, -1], [7, -1], [8, -1], [9, -1],
    // Spikes above the band
    [3, -2], [5, -2], [7, -2], [9, -2],
  ],
};

// Contextual animation states — additive layers on top of the behavior state
// machine. Each is driven by a different signal (mouse, chat lifecycle, tools).
let isHovered = false;        // cursor over the crab
let isListening = false;       // waiting for chat reply
let listeningStartAt = 0;
let danceUntil = 0;            // music playing → bounce to beat

function setListening(on) {
  isListening = !!on;
  if (on) listeningStartAt = performance.now();
}
function startDancing(durationMs) {
  danceUntil = performance.now() + (durationMs || 30000);
}

// Jump reaction — main process pushes a "clawd-react" IPC when frontmost app
// changes (and could push other events later).
const REACT_DURATION = 700;
let reactStartAt = null;
function triggerReact() {
  reactStartAt = performance.now();
}
if (window.crabAPI && window.crabAPI.onReact) {
  window.crabAPI.onReact(() => triggerReact());
}

// Thought bubbles — drawn above the crab. Used for both idle "thinking"
// thoughts AND timer-end alerts (label shows in the bubble, body hops too).
let activeThought = null; // { text, startedAt, duration }

function showThought(text, durationMs) {
  activeThought = { text, startedAt: performance.now(), duration: durationMs || 4500 };
}

// Idle thought timing — random interval between 6 and 16 minutes when Clawd
// is awake and nobody is chatting with him. Pulls from a small hand-written
// pool so we don't burn API credits on flavor text.
const IDLE_THOUGHTS = [
  '...crab thoughts.',
  'i wonder what clouds taste like.',
  'sand. miss the sand sometimes.',
  'is the dock breakable.',
  'maybe a tiny nap. just a tiny one.',
  'left or right. left or right. left.',
  'why is the cursor so fast.',
  'you should drink water btw.',
  '...zzz. wait. not yet.',
  'i am claude. but a crab.',
  'one day i will walk up the side.',
  'kinda hungry. for what though.',
  'good music day.',
  'somewhere a wave is breaking.',
];
let nextThoughtAt = performance.now() + 6 * 60_000 + Math.random() * 10 * 60_000;

function maybeShowIdleThought(now) {
  if (now < nextThoughtAt) return;
  if (isSleeping || externallyPaused || activeThought) {
    nextThoughtAt = now + 60_000; // try again in a minute
    return;
  }
  const text = IDLE_THOUGHTS[Math.floor(Math.random() * IDLE_THOUGHTS.length)];
  showThought(text, 4500);
  nextThoughtAt = now + 6 * 60_000 + Math.random() * 10 * 60_000;
}

// Timer-end alert. Persistent: keeps hopping every ~1.2s and bubble stays
// visible until the user clicks Clawd (handled in the mousedown listener) or
// 60 seconds elapse. A single hop got lost in the user's peripheral vision.
let timerAlertActive = false;
let timerAlertExpiresAt = 0;
let lastTimerAlertJumpAt = 0;
function clearTimerAlert() {
  timerAlertActive = false;
  activeThought = null;
}
if (window.crabAPI && window.crabAPI.onTimerEnded) {
  window.crabAPI.onTimerEnded((info) => {
    noteInteraction();
    const label = info && info.label ? info.label : 'timer';
    timerAlertActive = true;
    timerAlertExpiresAt = performance.now() + 60_000;
    lastTimerAlertJumpAt = performance.now();
    triggerReact();
    showThought(`time's up — ${label} (click me)`, 60_000);
  });
}

function legRaised(r, c, frame) {
  if (r !== rows - 1) return false;
  const isOuter = (c === 2 || c === 9);
  const isInner = (c === 4 || c === 7);
  if (frame === 1 && isOuter) return true;
  if (frame === 3 && isInner) return true;
  return false;
}

function currentBbox() {
  return {
    x: Math.floor(posX),
    y: canvas.height - crabH - 1,
    w: crabW,
    h: crabH,
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const moving = stateIsMoving() && !externallyPaused && !isSleeping;
  const bob = moving && (walkFrame === 0 || walkFrame === 2) ? -1 : 0;

  // Stretch bob: sine-arc up to ~3px during the stretch state.
  let stretchY = 0;
  if (behaviorState === ST.STRETCH && stateUntil > stateStartedAt) {
    const t = (performance.now() - stateStartedAt) / (stateUntil - stateStartedAt);
    if (t > 0 && t < 1) stretchY = -Math.sin(t * Math.PI) * 3;
  }
  const bbox = currentBbox();

  // Parabolic jump for reaction (~12px peak)
  let reactY = 0;
  if (reactStartAt !== null) {
    const elapsed = performance.now() - reactStartAt;
    if (elapsed >= REACT_DURATION) reactStartAt = null;
    else {
      const t = elapsed / REACT_DURATION;
      reactY = -(4 * t * (1 - t)) * 12;
    }
  }

  // Contextual offsets (additive on top of behavior-state + react animation).
  const tNow = performance.now();
  let hoverY = 0, swayX = 0, danceY = 0;
  if (isHovered) hoverY = -2;
  if (isListening) {
    const tSec = (tNow - listeningStartAt) / 1000;
    swayX = Math.sin(tSec * 3) * 1.5;
  }
  if (tNow < danceUntil) {
    danceY = Math.sin(tNow / 1000 * 2 * Math.PI * 2) * 2.5; // 2 Hz bounce
  }

  const drawX = bbox.x + Math.round(swayX);
  const drawY = bbox.y + bob + Math.round(reactY + stretchY + hoverY + danceY);
  const frame = moving ? walkFrame : 0;
  // Force eyes closed while sleeping (overrides blink scheduler).
  const eyesShown = !(eyesClosed || isSleeping);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = CRAB[r][c];
      if (ch === '.') continue;
      if (legRaised(r, c, frame)) continue;

      let color = COLORS[ch];
      if (!eyesShown && ch === 'X') color = COLORS.O;
      ctx.fillStyle = color;
      ctx.fillRect(drawX + c * SCALE, drawY + r * SCALE, SCALE, SCALE);
    }
  }

  if (!eyesShown) {
    ctx.fillStyle = COLORS.X;
    for (let c = 0; c < cols; c++) {
      if (CRAB[1][c] === 'X') {
        ctx.fillRect(
          drawX + c * SCALE,
          drawY + 1 * SCALE + Math.floor(SCALE / 2),
          SCALE,
          1
        );
      }
    }
  }

  // Permanent skin accessory (e.g., royal skin's crown). Drawn first so the
  // temporary tool-use accessory (glasses while reading) sits on top if both apply.
  if (currentSkinAccessory) {
    const cells = ACCESSORY_CELLS[currentSkinAccessory];
    if (cells) {
      ctx.fillStyle = currentSkinAccessoryColor || COLORS.X;
      for (const [c, r] of cells) {
        ctx.fillRect(drawX + c * SCALE, drawY + r * SCALE, SCALE, SCALE);
      }
    }
  }

  // Temporary accessory triggered by tool use (glasses, headphones, etc.).
  if (accessory && performance.now() < accessoryUntil) {
    const cells = ACCESSORY_CELLS[accessory];
    if (cells) {
      ctx.fillStyle = COLORS.X;
      for (const [c, r] of cells) {
        ctx.fillRect(drawX + c * SCALE, drawY + r * SCALE, SCALE, SCALE);
      }
    }
  } else if (accessory) {
    accessory = null;
  }

  // Z's float on top of everything (drawn last so they're visible even over the body).
  drawZParticles();

  // Thought bubble — above the crab, monochrome pixel-art-ish.
  if (activeThought) {
    const age = performance.now() - activeThought.startedAt;
    if (age >= activeThought.duration) {
      activeThought = null;
    } else {
      const bbox = currentBbox();
      const fontSize = Math.max(10, SCALE + 4);
      ctx.font = `${fontSize}px ui-monospace, Menlo, monospace`;
      const padding = 6;
      const text = activeThought.text;
      const metrics = ctx.measureText(text);
      const w = Math.ceil(metrics.width) + padding * 2;
      const h = Math.ceil(fontSize) + padding * 2;
      let bubbleX = bbox.x + bbox.w / 2 - w / 2;
      const bubbleY = bbox.y - h - 8;
      // Keep within canvas horizontally.
      if (bubbleX < 4) bubbleX = 4;
      if (bubbleX + w > canvas.width - 4) bubbleX = canvas.width - w - 4;
      // Fade in/out
      const t = age / activeThought.duration;
      let alpha = 1;
      if (t < 0.1) alpha = t / 0.1;
      else if (t > 0.85) alpha = (1 - t) / 0.15;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#f5f0e6';
      ctx.fillRect(bubbleX, bubbleY, w, h);
      ctx.fillStyle = '#000';
      // 1px black border
      ctx.fillRect(bubbleX, bubbleY, w, 1);
      ctx.fillRect(bubbleX, bubbleY + h - 1, w, 1);
      ctx.fillRect(bubbleX, bubbleY, 1, h);
      ctx.fillRect(bubbleX + w - 1, bubbleY, 1, h);
      // Tail (a small triangle of pixels pointing down at the crab)
      ctx.fillRect(bubbleX + w / 2 - 2, bubbleY + h, 4, 1);
      ctx.fillRect(bubbleX + w / 2 - 1, bubbleY + h + 1, 2, 1);
      // Text
      ctx.fillStyle = '#000';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(text, bubbleX + padding, bubbleY + h / 2);
      ctx.globalAlpha = 1;
    }
  }
}

let lastTickAt = performance.now();
function tick() {
  const now = performance.now();
  const dtMs = Math.min(50, now - lastTickAt); // clamp dt so tab-switch returns don't teleport particles
  lastTickAt = now;

  // Update sleep state every tick.
  if (!externallyPaused) {
    isSleeping = now - lastInteractionAt > SLEEP_AFTER_MS;
  }

  // Sleep visuals.
  spawnZIfSleeping(now);
  updateZParticles(dtMs);

  // Idle thoughts.
  maybeShowIdleThought(now);

  // Persistent timer alert — keep hopping every ~1.2s until acknowledged.
  if (timerAlertActive) {
    if (now > timerAlertExpiresAt) {
      clearTimerAlert();
    } else if (now - lastTimerAlertJumpAt > 1200) {
      triggerReact();
      lastTimerAlertJumpAt = now;
    }
  }

  if (!externallyPaused && !isSleeping) {
    if (now >= stateUntil) pickNextBehavior();

    const speed = stateSpeed();
    if (speed > 0) {
      posX += dir * speed;

      if (posX + crabW >= canvas.width) {
        posX = canvas.width - crabW;
        dir = -1;
        setState(ST.BOUNCE_PAUSE, 700);
      } else if (posX <= 0) {
        posX = 0;
        dir = 1;
        setState(ST.BOUNCE_PAUSE, 700);
      }

      if (now - lastStep >= stateStepMs()) {
        walkFrame = (walkFrame + 1) % 4;
        lastStep = now;
      }
    } else {
      // Planted — feet down.
      walkFrame = 0;
    }
  }

  if (eyesClosed && now >= blinkUntil) {
    eyesClosed = false;
    scheduleBlink(now);
  } else if (!eyesClosed && now >= nextBlink) {
    eyesClosed = true;
    blinkUntil = now + 120;
  }

  // Re-check mouse region every frame so the crab walking under a
  // stationary cursor still flips capture state.
  refreshMouseRegion();

  draw();
  requestAnimationFrame(tick);
}

// -------- mouse region machine --------

let lastMouseX = -1;
let lastMouseY = -1;
let currentlyCapturing = false;

function isOverCrab(x, y) {
  const b = currentBbox();
  return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
}

function refreshMouseRegion() {
  if (lastMouseX < 0) return;
  const overCrab = isOverCrab(lastMouseX, lastMouseY);
  isHovered = overCrab;
  const overChat = window.Chat && window.Chat.isOpen() && window.Chat.containsPoint(lastMouseX, lastMouseY);
  const shouldCapture = overCrab || overChat;

  if (shouldCapture !== currentlyCapturing) {
    currentlyCapturing = shouldCapture;
    if (window.crabAPI) window.crabAPI.setIgnoreMouse(!shouldCapture);
  }
}

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  refreshMouseRegion();
});

document.addEventListener('mousedown', (e) => {
  // Don't react if the click is inside the chat panel — chat.js handles it.
  if (window.Chat && window.Chat.isOpen()) {
    if (window.Chat.containsPoint(e.clientX, e.clientY)) return;
    // Click outside chat panel: close it.
    window.Chat.close();
    return;
  }
  if (isOverCrab(e.clientX, e.clientY)) {
    if (timerAlertActive) clearTimerAlert(); // clicking acknowledges the alarm
    triggerReact(); // small visible hop on click
    window.Chat.open(currentBbox());
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && window.Chat && window.Chat.isOpen()) {
    window.Chat.close();
  }
});

// API for chat.js
window.Crab = {
  pause() { externallyPaused = true; },
  resume() { externallyPaused = false; },
  getBbox: currentBbox,
  noteInteraction,
  isSleeping: () => isSleeping,
  handleToolUse,
  clearAccessory,
  setListening,
  dance: startDancing,
};

tick();
