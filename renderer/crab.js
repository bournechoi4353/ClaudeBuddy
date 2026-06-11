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
  // Personality affects both voice (in agent.js) AND behavior (here).
  const personalityId = p.personality || 'default';
  personalityBehavior = PERSONALITY_BEHAVIOR[personalityId] || PERSONALITY_BEHAVIOR.default;
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
// First-launch naming ceremony: when prefs.hasOnboarded is false, auto-open
// the chat panel a couple seconds after the crab appears so the user can name
// him. The "what should i be called" message lives in chat.js (it checks
// onboardingActive when it renders the panel's first message).
let onboardingActive = false;
if (window.crabAPI && window.crabAPI.getPrefs) {
  window.crabAPI.getPrefs().then((p) => {
    applyPrefs(p);
    if (p && p.hasOnboarded !== true) {
      onboardingActive = true;
      setTimeout(() => {
        if (window.Chat) window.Chat.open(currentBbox());
      }, 1800);
    }
  }).catch(() => {});
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

// Sleep state — declared early because scheduleBlink() below reads isDrowsy
// at module load (calling order: definitions → first call → tick loop).
let isSleeping = false;
let isDrowsy = false;
let yawnTriggered = false;

// Behavior state machine — gives Clawd unpredictable personality instead of
// just bouncing left/right forever. Each state has a duration; on expiry the
// next state is picked probabilistically.
const ST = {
  WALK: 'walk',           // moves at SPEED in dir
  SCUTTLE: 'scuttle',     // moves at 2x SPEED, faster leg cycle
  IDLE: 'idle',           // stands still, planted legs, looking around (blinks)
  STRETCH: 'stretch',     // tiny upward bob arc, no horizontal movement
  BOUNCE_PAUSE: 'bounce', // brief pause after hitting an outer wall
  NAP: 'nap',             // lays down for ~4s, eyes closed, slow breathing bob
  DIG: 'dig',             // rapid all-legs flicker, ~1.5s
  BURROW: 'burrow',       // body sinks into floor and pops back, ~1.5s
};
let behaviorState = ST.WALK;
let stateStartedAt = performance.now();
let stateUntil = performance.now() + 3000;

function setState(state, durationMs) {
  behaviorState = state;
  stateStartedAt = performance.now();
  stateUntil = stateStartedAt + durationMs;
}

// Personality-driven behavior weights. Each preset reshapes how often Clawd
// rests, scuttles, flips direction, and how fast he walks. Picked up from
// prefs.personality via applyPrefs.
const PERSONALITY_BEHAVIOR = {
  default: { speedMul: 1.0, idleChance: 0.25, scuttleChance: 0.10, idleDurationMul: 1.0, blinkIntervalMul: 1.0, flipChance: 0.25 },
  sleepy:  { speedMul: 0.6, idleChance: 0.50, scuttleChance: 0.03, idleDurationMul: 1.8, blinkIntervalMul: 0.6, flipChance: 0.15 },
  excited: { speedMul: 1.6, idleChance: 0.08, scuttleChance: 0.35, idleDurationMul: 0.5, blinkIntervalMul: 1.5, flipChance: 0.40 },
  zen:     { speedMul: 0.8, idleChance: 0.35, scuttleChance: 0.05, idleDurationMul: 1.6, blinkIntervalMul: 1.0, flipChance: 0.08 },
  snarky:  { speedMul: 1.1, idleChance: 0.20, scuttleChance: 0.15, idleDurationMul: 0.7, blinkIntervalMul: 1.0, flipChance: 0.35 },
  formal:  { speedMul: 0.95, idleChance: 0.22, scuttleChance: 0.00, idleDurationMul: 1.0, blinkIntervalMul: 1.0, flipChance: 0.12 },
};
let personalityBehavior = PERSONALITY_BEHAVIOR.default;

function pickNextBehavior() {
  // Returning from a stop: resume walking, sometimes flipped.
  if (
    behaviorState === ST.IDLE ||
    behaviorState === ST.STRETCH ||
    behaviorState === ST.BOUNCE_PAUSE ||
    behaviorState === ST.NAP ||
    behaviorState === ST.DIG ||
    behaviorState === ST.BURROW
  ) {
    if (Math.random() < (personalityBehavior.flipChance + 0.1)) dir = -dir;
    setState(ST.WALK, 4000 + Math.random() * 6000);
    return;
  }
  if (behaviorState === ST.SCUTTLE) {
    setState(ST.WALK, 3000 + Math.random() * 4000);
    return;
  }
  // From WALK, pick a new mood, weighted by personality. Sometimes upgrade
  // a basic mood to a richer animation so the loop doesn't feel too repetitive.
  const pb = personalityBehavior;
  const r = Math.random();
  const stretchCutoff = pb.idleChance + 0.10;
  const scuttleCutoff = stretchCutoff + pb.scuttleChance;
  if (r < pb.idleChance) {
    // 25% chance an IDLE turns into a NAP. Sleepy personalities nap more.
    const napChance = pb.speedMul < 0.9 ? 0.45 : 0.20;
    if (Math.random() < napChance) {
      setState(ST.NAP, 3500 + Math.random() * 2500);
    } else {
      setState(ST.IDLE, (1500 + Math.random() * 3000) * pb.idleDurationMul);
    }
  } else if (r < stretchCutoff) {
    // 20% chance a STRETCH turns into a BURROW.
    if (Math.random() < 0.20) {
      setState(ST.BURROW, 1400 + Math.random() * 400);
    } else {
      setState(ST.STRETCH, 700 + Math.random() * 400);
    }
  } else if (r < scuttleCutoff) {
    // 30% chance a SCUTTLE turns into a DIG.
    if (Math.random() < 0.30) {
      setState(ST.DIG, 1200 + Math.random() * 600);
    } else {
      setState(ST.SCUTTLE, 1500 + Math.random() * 2000);
    }
  } else {
    if (Math.random() < pb.flipChance) dir = -dir;
    setState(ST.WALK, 2000 + Math.random() * 4000);
  }
}

function stateSpeed() {
  let base = 0;
  if (behaviorState === ST.WALK) base = SPEED;
  else if (behaviorState === ST.SCUTTLE) base = SPEED * 2;
  const mul = (personalityBehavior.speedMul || 1.0) * (isDrowsy ? 0.5 : 1.0);
  return base * mul;
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
  // Faster blinks when drowsy, slower for sleepy personality, faster for excited.
  const base = 2500 + Math.random() * 3500;
  const personalityMul = personalityBehavior.blinkIntervalMul || 1.0;
  const drowsyMul = isDrowsy ? 0.3 : 1.0;
  nextBlink = t + (base / personalityMul) * drowsyMul;
}
scheduleBlink(performance.now());

// Sleep — after N ms of no chat interaction, Clawd dozes off. The transition
// is graduated: AWAKE → DROWSY (last 3s before sleep, slower walks + faster
// blinks + a yawn bubble) → ASLEEP. Waking from sleep plays a quick stretch.
// (isSleeping/isDrowsy/yawnTriggered are declared earlier — scheduleBlink
// references isDrowsy at module-load time.)
let SLEEP_AFTER_MS = 3 * 60 * 1000;
const DROWSY_LEAD_MS = 3000;
let lastInteractionAt = performance.now();

// ---- Time-of-day greeting ----
// First chat-open or message-send of a session gets a small contextual bubble:
// "morning", "you're still up?", "back?", etc. Greets again if the user
// returns after a long absence (>4h) so a multi-day chat doesn't go silent.
let hasGreetedThisSession = false;
function pickGreeting(now, lastEpoch) {
  const hour = now.getHours();
  const gapHours = lastEpoch ? (now.getTime() - lastEpoch) / 3_600_000 : Infinity;
  // Late night first — overrides the "morning" range edge cases.
  if (hour >= 0 && hour < 5) {
    if (gapHours > 4) return 'oh hey. late one?';
    return "you're still up?";
  }
  if (hour >= 5 && hour < 11 && gapHours > 6) return 'morning.';
  if (hour >= 11 && hour < 14 && gapHours > 6) return 'back. lunch?';
  if (hour >= 14 && hour < 18 && gapHours > 6) return 'oh hey. afternoon.';
  if (hour >= 18 && hour < 22 && gapHours > 6) return 'evening then.';
  if (hour >= 22 && gapHours > 6) return 'late hello.';
  if (gapHours > 1 && gapHours <= 6) return 'hey, back.';
  return null;
}
function maybeGreet() {
  if (hasGreetedThisSession) return;
  let lastEpoch = null;
  try {
    const v = localStorage.getItem('clawd_last_interaction_epoch');
    if (v) lastEpoch = parseInt(v, 10) || null;
  } catch (_) {}
  const now = new Date();
  const greeting = pickGreeting(now, lastEpoch);
  // Always update the persisted timestamp, even if we don't greet.
  try { localStorage.setItem('clawd_last_interaction_epoch', String(now.getTime())); } catch (_) {}
  if (greeting) {
    hasGreetedThisSession = true;
    showThought(greeting, 4000);
  } else {
    // First interaction with no qualifying gap still counts as "greeted" so we
    // don't loop checks every tap. Long absence later in the session will
    // re-arm via the 4h check below.
    hasGreetedThisSession = true;
  }
}
// Re-arm greeting whenever the gap since last interaction exceeds 4h, even
// within a single app session — handles "left clawd running overnight" case.
function maybeReArmGreeting() {
  try {
    const v = localStorage.getItem('clawd_last_interaction_epoch');
    if (!v) return;
    const gapH = (Date.now() - parseInt(v, 10)) / 3_600_000;
    if (gapH > 4) hasGreetedThisSession = false;
  } catch (_) {}
}

function noteInteraction() {
  const wasSleeping = isSleeping;
  lastInteractionAt = performance.now();
  isSleeping = false;
  isDrowsy = false;
  yawnTriggered = false;
  zParticles.length = 0;
  if (wasSleeping) {
    setState(ST.STRETCH, 1000);
    showThought('*stretches*', 1400);
  }
  maybeReArmGreeting();
  maybeGreet();
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
let isSpeaking = false;        // TTS audio playing → mouth-along bob
let speakingLevel = 0;         // 0..1 live amplitude of Clawd's own voice

function setListening(on) {
  isListening = !!on;
  if (on) listeningStartAt = performance.now();
}
function startDancing(durationMs) {
  danceUntil = performance.now() + (durationMs || 30000);
}
function setSpeaking(on) {
  isSpeaking = !!on;
  if (!on) speakingLevel = 0;
}
function setSpeakingLevel(level) {
  speakingLevel = Math.max(0, Math.min(1, level || 0));
}

// Jump reaction — main process pushes a "clawd-react" IPC when frontmost app
// changes (and could push other events later).
const REACT_DURATION = 700;
let reactStartAt = null;
function triggerReact() {
  reactStartAt = performance.now();
}
// Woke up from a hands-free "clawd" — a hop plus a brief listening sway so it's
// clear he heard the wake word.
function wakePerk() {
  triggerReact();
  setListening(true);
  setTimeout(() => setListening(false), 1500);
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

// Update the live bubble's text WITHOUT resetting its clock — used for streaming
// voice replies into the bubble chunk by chunk (resetting startedAt each chunk
// would replay the fade-in and flicker). Extends the deadline so the bubble
// never starts fading mid-stream.
function updateThought(text, durationMs) {
  if (!activeThought) {
    showThought(text, durationMs);
    return;
  }
  activeThought.text = text;
  const age = performance.now() - activeThought.startedAt;
  activeThought.duration = Math.max(activeThought.duration, age + (durationMs || 4500));
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

// Proactive ambient nudges from main (low battery, upcoming calendar event,
// etc.). Lighter than the timer alert: single hop + bubble for ~15-25s.
if (window.crabAPI && window.crabAPI.onNotify) {
  window.crabAPI.onNotify((info) => {
    if (!info || !info.text) return;
    noteInteraction();
    triggerReact();
    showThought(info.text, info.durationMs || 15_000);
  });
}

function legRaised(r, c, frame) {
  if (r !== rows - 1) return false;
  const isOuter = (c === 2 || c === 9);
  const isInner = (c === 4 || c === 7);
  // DIG: all four legs flicker between outer-pair and inner-pair every ~120ms,
  // much faster than the normal walk cycle.
  if (behaviorState === ST.DIG) {
    const digFrame = Math.floor(performance.now() / 120) % 2;
    if (digFrame === 0 && isOuter) return true;
    if (digFrame === 1 && isInner) return true;
    return false;
  }
  if (frame === 1 && isOuter) return true;
  if (frame === 3 && isInner) return true;
  return false;
}

// Drag state. While dragging, the crab's bbox tracks the cursor (minus the
// grab anchor) instead of the floor position.
let isDragging = false;
let dragPressed = false; // mousedown over crab; not yet past drag threshold
let dragStartX = 0, dragStartY = 0;
let dragGrabOffsetX = 0, dragGrabOffsetY = 0;
let dragCursorX = 0, dragCursorY = 0;
const DRAG_THRESHOLD = 5;

// Velocity sampling for throw physics. We smooth recent mouse motion so that
// the launch velocity reflects the user's last gesture, not a single noisy
// final mousemove.
let lastDragSampleAt = 0;
let lastDragSampleX = 0, lastDragSampleY = 0;
let dragVX = 0, dragVY = 0; // px per frame (~16.67ms)

// Throw / fly state. Set when the user releases with enough velocity; the
// crab then undergoes a parabolic arc with bouncing off floor and walls until
// energy drains and he settles back into normal walking.
let isFlying = false;
let flyX = 0, flyY = 0, flyVX = 0, flyVY = 0;
const GRAVITY = 0.6;          // px/frame²
const AIR_FRICTION = 0.995;   // horizontal drag while flying
const BOUNCE_DAMP = 0.45;     // vertical energy retained per bounce
const WALL_DAMP = 0.5;        // horizontal energy retained on wall hit
const FLY_SETTLE_VEL = 1.2;   // below this on landing, settle
const THROW_VEL_THRESHOLD = 2.5; // px/frame; below this on release, just place down

function currentBbox() {
  if (isDragging) {
    const x = Math.max(0, Math.min(canvas.width - crabW, Math.round(dragCursorX - dragGrabOffsetX)));
    const y = Math.max(0, Math.min(canvas.height - crabH, Math.round(dragCursorY - dragGrabOffsetY)));
    return { x, y, w: crabW, h: crabH };
  }
  if (isFlying) {
    return { x: Math.round(flyX), y: Math.round(flyY), w: crabW, h: crabH };
  }
  return {
    x: Math.floor(posX),
    y: canvas.height - crabH - 1,
    w: crabW,
    h: crabH,
  };
}

function stepFlyPhysics() {
  if (!isFlying) return;
  flyVY += GRAVITY;
  flyVX *= AIR_FRICTION;
  flyX += flyVX;
  flyY += flyVY;
  // Wall collisions — lose some horizontal energy and reverse.
  if (flyX < 0) { flyX = 0; flyVX = -flyVX * WALL_DAMP; }
  const maxX = canvas.width - crabW;
  if (flyX > maxX) { flyX = maxX; flyVX = -flyVX * WALL_DAMP; }
  // Floor collision.
  const floorY = canvas.height - crabH - 1;
  if (flyY >= floorY) {
    flyY = floorY;
    const totalSpeed = Math.abs(flyVY) + Math.abs(flyVX);
    if (totalSpeed < FLY_SETTLE_VEL) {
      // Energy spent — settle.
      posX = Math.max(0, Math.min(maxX, Math.round(flyX)));
      isFlying = false;
      flyVX = 0; flyVY = 0;
      if (!(window.Chat && window.Chat.isOpen())) externallyPaused = false;
      triggerReact();
    } else {
      // Bounce — flip & damp vertical velocity, damp horizontal a bit too.
      flyVY = -Math.abs(flyVY) * BOUNCE_DAMP;
      flyVX *= 0.85;
    }
  }
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

  // SPEAKING: bob amplitude tracks Clawd's live voice level so he visibly mouths
  // along to what he's saying. A small base bob + amplitude-scaled lift.
  let speakY = 0;
  if (isSpeaking) {
    const tSec = tNow / 1000;
    speakY = -(0.8 + speakingLevel * 4) * (0.6 + 0.4 * Math.abs(Math.sin(tSec * 12)));
  }

  // NAP: body sinks 1-2 px (resting on the floor) with a slow breathing bob.
  let napY = 0;
  if (behaviorState === ST.NAP) {
    const tSec = (tNow - stateStartedAt) / 1000;
    napY = 1 + Math.sin(tSec * 1.6) * 0.5;
  }

  // BURROW: body sinks INTO the floor (drawY pushed down so bottom rows clip
  // off the canvas) then pops back. Symmetric sine arc over state duration.
  let burrowY = 0;
  let burrowRowsToHide = 0;
  if (behaviorState === ST.BURROW && stateUntil > stateStartedAt) {
    const t = (tNow - stateStartedAt) / (stateUntil - stateStartedAt);
    if (t > 0 && t < 1) {
      const dig = Math.sin(t * Math.PI); // 0 → 1 → 0
      burrowY = dig * (crabH * 0.55);
      // As Clawd "digs in" his bottom rows are buried — hide them so the
      // tunnel doesn't render below the floor line.
      burrowRowsToHide = Math.floor(dig * (rows - 2));
    }
  }

  const drawX = bbox.x + Math.round(swayX);
  const drawY = bbox.y + bob + Math.round(reactY + stretchY + hoverY + danceY + speakY + napY + burrowY);
  const frame = moving ? walkFrame : 0;
  // Force eyes closed while sleeping OR napping (overrides blink scheduler).
  const eyesShown = !(eyesClosed || isSleeping || behaviorState === ST.NAP);
  const maxRow = rows - burrowRowsToHide;

  for (let r = 0; r < maxRow; r++) {
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
      // Word-wrap into lines (voice replies stream whole sentences into the
      // bubble — a single line would blow out the canvas width). When the text
      // overflows the cap, keep the LAST lines so it reads like live captions.
      const maxTextW = Math.min(300, canvas.width - 28);
      const MAX_LINES = 5;
      const words = activeThought.text.split(/\s+/).filter(Boolean);
      let lines = [];
      let cur = '';
      for (const word of words) {
        const tryLine = cur ? cur + ' ' + word : word;
        if (cur && ctx.measureText(tryLine).width > maxTextW) {
          lines.push(cur);
          cur = word;
        } else {
          cur = tryLine;
        }
      }
      if (cur) lines.push(cur);
      if (lines.length === 0) lines = [''];
      if (lines.length > MAX_LINES) lines = lines.slice(lines.length - MAX_LINES);
      const lineH = fontSize + 4;
      let textW = 0;
      for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
      const w = Math.ceil(Math.min(maxTextW, textW)) + padding * 2;
      const h = lines.length * lineH + padding * 2;
      let bubbleX = bbox.x + bbox.w / 2 - w / 2;
      const bubbleY = Math.max(4, bbox.y - h - 8);
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
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], bubbleX + padding, bubbleY + padding + li * lineH + lineH / 2);
      }
      ctx.globalAlpha = 1;
    }
  }
}

let lastTickAt = performance.now();
function tick() {
  const now = performance.now();
  const dtMs = Math.min(50, now - lastTickAt); // clamp dt so tab-switch returns don't teleport particles
  lastTickAt = now;

  // Throw physics run before behavior — while flying, Clawd doesn't walk or
  // pick new behaviors; he just arcs through the air.
  stepFlyPhysics();

  // Sleep state machine: AWAKE → DROWSY (last 3s before sleep) → ASLEEP.
  if (!externallyPaused) {
    const timeIdle = now - lastInteractionAt;
    if (timeIdle > SLEEP_AFTER_MS) {
      isSleeping = true;
      isDrowsy = false;
    } else if (timeIdle > SLEEP_AFTER_MS - DROWSY_LEAD_MS) {
      isSleeping = false;
      isDrowsy = true;
      if (!yawnTriggered) {
        yawnTriggered = true;
        showThought('*yawn*', 1800);
      }
    } else {
      isSleeping = false;
      isDrowsy = false;
      yawnTriggered = false;
    }
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
  // Keep capturing while a drag is in progress (or about to start) so the
  // mouse doesn't slip out from under us when Clawd moves with the cursor.
  const shouldCapture = overCrab || overChat || isDragging || dragPressed;

  if (shouldCapture !== currentlyCapturing) {
    currentlyCapturing = shouldCapture;
    if (window.crabAPI) window.crabAPI.setIgnoreMouse(!shouldCapture);
  }
}

document.addEventListener('mousemove', (e) => {
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  if (dragPressed) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (!isDragging && (dx * dx + dy * dy) > DRAG_THRESHOLD * DRAG_THRESHOLD) {
      isDragging = true;
      externallyPaused = true; // pause walking while held
      lastDragSampleAt = performance.now();
      lastDragSampleX = e.clientX;
      lastDragSampleY = e.clientY;
      dragVX = 0; dragVY = 0;
    }
    if (isDragging) {
      dragCursorX = e.clientX;
      dragCursorY = e.clientY;
      // Smooth recent motion into a per-frame velocity. Mix old + new so the
      // release captures the user's intent over the last few ms, not just the
      // final twitchy mousemove.
      const now = performance.now();
      const dtMs = Math.max(8, now - lastDragSampleAt);
      const instVX = ((e.clientX - lastDragSampleX) / dtMs) * 16.67;
      const instVY = ((e.clientY - lastDragSampleY) / dtMs) * 16.67;
      dragVX = dragVX * 0.4 + instVX * 0.6;
      dragVY = dragVY * 0.4 + instVY * 0.6;
      lastDragSampleAt = now;
      lastDragSampleX = e.clientX;
      lastDragSampleY = e.clientY;
    }
  }
  refreshMouseRegion();
});

document.addEventListener('mousedown', (e) => {
  // Only the primary (left) button drives drag / click-to-chat / close. The
  // right button is handled by the contextmenu listener below (opens the menu),
  // so we bail here to keep a right-click from also starting a drag or opening
  // chat on mouseup.
  if (e.button !== 0) return;
  // Inside the chat panel — chat.js owns those events.
  if (window.Chat && window.Chat.isOpen() && window.Chat.containsPoint(e.clientX, e.clientY)) {
    return;
  }
  if (isOverCrab(e.clientX, e.clientY)) {
    // Start tracking — could turn into a drag (>5px move) or a click (no move).
    // Crab is grabbable whether the chat panel is open or not; the panel will
    // follow him via its own spring-tracked position.
    // Catching a flying crab mid-arc cancels the throw.
    if (isFlying) {
      isFlying = false;
      flyVX = 0; flyVY = 0;
    }
    const b = currentBbox();
    dragPressed = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragGrabOffsetX = e.clientX - b.x;
    dragGrabOffsetY = e.clientY - b.y;
    dragCursorX = e.clientX;
    dragCursorY = e.clientY;
    noteInteraction();
    return;
  }
  // Mousedown anywhere else with chat open → close the chat.
  if (window.Chat && window.Chat.isOpen()) {
    window.Chat.close();
  }
});

document.addEventListener('mouseup', (e) => {
  if (!dragPressed) return;
  const wasDragging = isDragging;
  const chatWasOpen = window.Chat && window.Chat.isOpen();
  if (wasDragging) {
    // Capture the drag bbox BEFORE clearing isDragging — otherwise currentBbox
    // falls back to the floor position and the fly state starts pre-landed.
    const b = currentBbox();
    isDragging = false;
    dragPressed = false;
    // Always hand off to physics — gravity makes drops fall naturally, and the
    // settle check inside stepFlyPhysics ends a velocity-less floor release in
    // a single frame, so this also covers the old "place down" path.
    isFlying = true;
    flyX = b.x;
    flyY = b.y;
    flyVX = dragVX;
    flyVY = dragVY;
    // externallyPaused stays true until physics settles (or chat owns it).
    refreshMouseRegion();
    return;
  }
  // Click (no movement past threshold).
  dragPressed = false;
  if (isOverCrab(e.clientX, e.clientY) && !chatWasOpen) {
    if (timerAlertActive) clearTimerAlert();
    triggerReact();
    window.Chat.open(currentBbox());
  }
  refreshMouseRegion();
});

// Right-click the crab to open the settings menu at the cursor. This is the
// primary way to reach settings on Windows (the tray icon hides in the system-
// tray overflow) and a handy shortcut on macOS. Right-clicks anywhere else fall
// through untouched.
document.addEventListener('contextmenu', (e) => {
  if (isOverCrab(e.clientX, e.clientY)) {
    e.preventDefault();
    noteInteraction();
    window.crabAPI.openMenu();
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
  setSpeaking,
  setSpeakingLevel,
  wakePerk,
  think: showThought,
  thinkUpdate: updateThought,
  isOnboarding: () => onboardingActive,
  endOnboarding: () => { onboardingActive = false; },
};

tick();
