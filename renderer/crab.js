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
  O: '#CC785C',
  X: '#000000',
};

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

let posX = 0;
let dir = 1;
const SPEED = 0.5;
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
const SLEEP_AFTER_MS = 3 * 60 * 1000;
let lastInteractionAt = performance.now();
let isSleeping = false;
function noteInteraction() {
  lastInteractionAt = performance.now();
  isSleeping = false;
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
};

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
  const drawX = bbox.x;

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

  const drawY = bbox.y + bob + Math.round(reactY + stretchY);
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

  // Accessories on top of everything else.
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
}

function tick() {
  const now = performance.now();

  // Update sleep state every tick.
  if (!externallyPaused) {
    isSleeping = now - lastInteractionAt > SLEEP_AFTER_MS;
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
};

tick();
