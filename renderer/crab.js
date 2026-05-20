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

const SCALE = 6;

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');

const cols = CRAB[0].length;
const rows = CRAB.length;
const crabW = cols * SCALE;
const crabH = rows * SCALE;

function fitCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
fitCanvas();
window.addEventListener('resize', fitCanvas);

let posX = 0;
let dir = 1;
const SPEED = 0.5;
let isWalking = true;
let resumeWalkAt = 0;
let externallyPaused = false; // chat open

let walkFrame = 0;
let lastStep = 0;
const STEP_MS = 220;

let eyesClosed = false;
let nextBlink = 0;
let blinkUntil = 0;
function scheduleBlink(t) {
  nextBlink = t + 2500 + Math.random() * 3500;
}
scheduleBlink(performance.now());

// Sleep — after N ms of no chat interaction, Clawd dozes off.
const SLEEP_AFTER_MS = 5 * 60 * 1000;
let lastInteractionAt = performance.now();
let isSleeping = false;
function noteInteraction() {
  lastInteractionAt = performance.now();
  isSleeping = false;
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

function legRaised(r, c, frame) {
  if (r !== rows - 1) return false;
  const isOuter = (c === 2 || c === 9);
  const isInner = (c === 4 || c === 7);
  if (frame === 1 && isOuter) return true;
  if (frame === 3 && isInner) return true;
  return false;
}

// Display layout: list of {leftX, rightX, bottomY} segments in window coords,
// one per monitor. Pulled at startup via IPC; until it arrives we fall back
// to the canvas bottom (one frame at most).
let segments = null;
if (window.crabAPI && window.crabAPI.getLayout) {
  window.crabAPI.getLayout().then((layout) => {
    if (layout && Array.isArray(layout.segments) && layout.segments.length) {
      segments = layout.segments;
    }
  });
}

function findSegmentIndex(x) {
  if (!segments) return -1;
  for (let i = 0; i < segments.length; i++) {
    if (x >= segments[i].leftX && x < segments[i].rightX) return i;
  }
  return -1;
}

function currentBbox() {
  let bot;
  if (segments) {
    const cx = posX + crabW / 2;
    const idx = findSegmentIndex(cx);
    bot = idx >= 0 ? segments[idx].bottomY : segments[0].bottomY;
  } else {
    bot = canvas.height;
  }
  return {
    x: Math.floor(posX),
    y: bot - crabH - 1,
    w: crabW,
    h: crabH,
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const moving = isWalking && !externallyPaused && !isSleeping;
  const bob = moving && (walkFrame === 0 || walkFrame === 2) ? -1 : 0;
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

  const drawY = bbox.y + bob + Math.round(reactY);
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
}

function tick() {
  const now = performance.now();

  // Update sleep state every tick.
  if (!externallyPaused) {
    isSleeping = now - lastInteractionAt > SLEEP_AFTER_MS;
  }

  if (!externallyPaused && !isSleeping) {
    if (!isWalking && now >= resumeWalkAt) {
      isWalking = true;
      lastStep = now;
    }

    if (isWalking) {
      const oldX = posX;
      posX += dir * SPEED;

      const leftBound = segments ? segments[0].leftX : 0;
      const rightBound = segments ? segments[segments.length - 1].rightX : canvas.width;

      if (posX + crabW >= rightBound) {
        posX = rightBound - crabW;
        dir = -1;
        isWalking = false;
        resumeWalkAt = now + 700;
      } else if (posX <= leftBound) {
        posX = leftBound;
        dir = 1;
        isWalking = false;
        resumeWalkAt = now + 700;
      } else if (segments) {
        // If we stepped into a gap between monitors, teleport to the
        // adjacent monitor in the walking direction.
        const cx = posX + crabW / 2;
        if (findSegmentIndex(cx) === -1) {
          if (dir > 0) {
            const next = segments.find((s) => s.leftX > oldX);
            if (next) posX = next.leftX;
          } else {
            const prev = [...segments].reverse().find((s) => s.rightX <= oldX + crabW);
            if (prev) posX = prev.rightX - crabW;
          }
        }
      }
      if (now - lastStep >= STEP_MS) {
        walkFrame = (walkFrame + 1) % 4;
        lastStep = now;
      }
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
};

tick();
