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

  const moving = isWalking && !externallyPaused;
  const bob = moving && (walkFrame === 0 || walkFrame === 2) ? -1 : 0;
  const bbox = currentBbox();
  const drawX = bbox.x;
  const drawY = bbox.y + bob;
  const frame = moving ? walkFrame : 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = CRAB[r][c];
      if (ch === '.') continue;
      if (legRaised(r, c, frame)) continue;

      let color = COLORS[ch];
      if (eyesClosed && ch === 'X') color = COLORS.O;
      ctx.fillStyle = color;
      ctx.fillRect(drawX + c * SCALE, drawY + r * SCALE, SCALE, SCALE);
    }
  }

  if (eyesClosed) {
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

  if (!externallyPaused) {
    if (!isWalking && now >= resumeWalkAt) {
      isWalking = true;
      lastStep = now;
    }

    if (isWalking) {
      posX += dir * SPEED;
      if (posX + crabW >= canvas.width) {
        posX = canvas.width - crabW;
        dir = -1;
        isWalking = false;
        resumeWalkAt = now + 700;
      } else if (posX <= 0) {
        posX = 0;
        dir = 1;
        isWalking = false;
        resumeWalkAt = now + 700;
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
};

tick();
