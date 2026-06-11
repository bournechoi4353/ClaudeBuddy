// Phase 4: real Claude responses via the Agent SDK (subscription auth).
// Renderer-side: streams text chunks into the current crab message DOM node.

const chatEl = document.getElementById('chat');
const historyEl = document.getElementById('history');
const inputEl = document.getElementById('input');
const micBtn = document.getElementById('micBtn');

const PANEL_W = 240;
const PANEL_MARGIN = 8;
let NAME = 'clawd';
if (window.crabAPI && window.crabAPI.getPrefs) {
  window.crabAPI.getPrefs().then((p) => {
    if (p && typeof p.petName === 'string' && p.petName) NAME = p.petName;
  }).catch(() => {});
}
if (window.crabAPI && window.crabAPI.onPrefsUpdated) {
  window.crabAPI.onPrefsUpdated((p) => {
    if (p && typeof p.petName === 'string' && p.petName) NAME = p.petName;
  });
}

let isOpen = false;
let currentReplyEl = null;
let inFlight = false;

window.crabAPI.onChatPiece((piece) => {
  if (piece.type === 'tool') {
    if (window.Crab && window.Crab.handleToolUse) window.Crab.handleToolUse(piece.name);
    // Spotify play tools → start dance mode for 30s.
    if (
      piece.name && /spotify_play(_uri)?$/.test(piece.name) &&
      window.Crab && window.Crab.dance
    ) {
      window.Crab.dance(30000);
    }
    return;
  }
  if (piece.type === 'chunk') {
    if (!currentReplyEl) {
      currentReplyEl = document.createElement('div');
      currentReplyEl.className = 'msg crab';
      currentReplyEl.textContent = NAME + ': ';
      historyEl.appendChild(currentReplyEl);
    }
    currentReplyEl.textContent += piece.text;
    historyEl.scrollTop = historyEl.scrollHeight;
    // Voice turn with the panel closed → stream the reply into the bubble.
    if (voiceTurn) {
      voiceReplyText += piece.text;
      if (window.Crab && window.Crab.thinkUpdate) window.Crab.thinkUpdate(voiceReplyText.trim(), 12000);
    }
  } else if (piece.type === 'error') {
    // Map common SDK-level errors to in-character messages instead of leaking
    // raw error strings to the user.
    const raw = (piece.error || '').toLowerCase();
    let friendly;
    if (raw.includes('invalid_api_key') || raw.includes('authentication') || raw.includes('credentials')) {
      friendly = "i can't reach claude right now. make sure you've run `claude login` in a terminal, then try again.";
    } else if (raw.includes('rate') && raw.includes('limit')) {
      friendly = 'too many words too fast. try again in a bit.';
    } else if (raw.includes('network') || raw.includes('econn') || raw.includes('fetch failed')) {
      friendly = "can't reach the internet right now. check your wifi?";
    } else if (raw.includes('sdk load')) {
      friendly = 'something\'s off with my brain. try restarting clawd?';
    } else {
      friendly = "hmm, something went sideways. try again?";
    }
    addMessage('crab', friendly);
    if (voiceTurn && window.Crab && window.Crab.thinkUpdate) window.Crab.thinkUpdate(friendly, 6000);
    currentReplyEl = null;
  } else if (piece.type === 'done') {
    currentReplyEl = null;
    inFlight = false;
    if (voiceTurn) {
      // Let the finished bubble linger a beat, then fade.
      if (voiceReplyText.trim() && window.Crab && window.Crab.thinkUpdate) {
        window.Crab.thinkUpdate(voiceReplyText.trim(), 7000);
      }
      voiceTurn = false;
    }
    if (window.Crab && window.Crab.setListening) window.Crab.setListening(false);
    if (window.Crab && window.Crab.clearAccessory) window.Crab.clearAccessory();
  }
});

// Spring-physics tracking. The panel chases Clawd's current bbox each frame
// with a stiff-but-springy feel — when he's dragged or hops, the panel lags
// slightly behind, then settles with a tiny overshoot so the motion looks
// alive instead of glued.
let panelX = 0, panelY = 0;
let velX = 0, velY = 0;
let trackRAF = 0;
const SPRING_K = 0.22;   // higher = catches up faster
const SPRING_D = 0.74;   // lower  = more overshoot/bounce

function targetForBbox(crabBbox) {
  let tx = crabBbox.x + crabBbox.w / 2 - PANEL_W / 2;
  if (tx < PANEL_MARGIN) tx = PANEL_MARGIN;
  if (tx + PANEL_W > window.innerWidth - PANEL_MARGIN) {
    tx = window.innerWidth - PANEL_W - PANEL_MARGIN;
  }
  // ty is the distance from the bottom of the window to the bottom edge of
  // the panel — anchoring by bottom keeps the panel growing UP as messages
  // stream in, instead of expanding down into the crab.
  const ty = window.innerHeight - crabBbox.y + 6;
  return { tx, ty };
}

function applyPanelPosition() {
  chatEl.style.left = Math.round(panelX) + 'px';
  chatEl.style.top = '';
  chatEl.style.bottom = Math.round(panelY) + 'px';
}

function trackTick() {
  if (!isOpen) { trackRAF = 0; return; }
  const bbox = window.Crab && window.Crab.getBbox ? window.Crab.getBbox() : null;
  if (bbox) {
    const { tx, ty } = targetForBbox(bbox);
    velX = (velX + (tx - panelX) * SPRING_K) * SPRING_D;
    velY = (velY + (ty - panelY) * SPRING_K) * SPRING_D;
    panelX += velX;
    panelY += velY;
    applyPanelPosition();
  }
  trackRAF = requestAnimationFrame(trackTick);
}

function open(crabBbox) {
  isOpen = true;
  chatEl.classList.add('open');
  // Snap to the starting position so the open animation doesn't include a
  // big spring catch-up from (0,0).
  const { tx, ty } = targetForBbox(crabBbox);
  panelX = tx; panelY = ty; velX = 0; velY = 0;
  applyPanelPosition();

  if (historyEl.children.length === 0) {
    if (window.Crab && window.Crab.isOnboarding && window.Crab.isOnboarding()) {
      addMessage('crab', "hi! i'm new here. what should i be called?");
    } else {
      addMessage('crab', "hi. ask me anything.");
    }
  }

  window.Crab.pause();
  window.Crab.noteInteraction && window.Crab.noteInteraction();
  setTimeout(() => inputEl.focus(), 0);

  if (!trackRAF) trackRAF = requestAnimationFrame(trackTick);
}

function close() {
  isOpen = false;
  chatEl.classList.remove('open');
  if (trackRAF) { cancelAnimationFrame(trackRAF); trackRAF = 0; }
  window.Crab.resume();
  inputEl.value = '';
  inputEl.blur();
}

function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = (who === 'you' ? '> ' : NAME + ': ') + text;
  historyEl.appendChild(div);
  historyEl.scrollTop = historyEl.scrollHeight;
}

// Send a message through the agent. Shared by the text input (Enter), the mic
// button, and the hands-free wake word. Voice-initiated turns with the panel
// CLOSED stay closed — the reply streams into the crab's thought bubble instead
// (and is spoken aloud). The exchange still lands in the panel history, so
// clicking the crab later shows the full conversation.
let voiceTurn = false;
let voiceReplyText = '';
function submit(text, opts) {
  const t = (text || '').trim();
  if (!t || inFlight) return;
  const fromVoice = !!(opts && opts.voice);
  if (!isOpen && !fromVoice) open(window.Crab.getBbox());
  voiceTurn = fromVoice && !isOpen;
  voiceReplyText = '';
  addMessage('you', t);
  inputEl.value = '';
  inFlight = true;
  window.Crab.noteInteraction && window.Crab.noteInteraction();
  window.Crab.setListening && window.Crab.setListening(true);
  window.crabAPI.sendChatMessage(t);
  // After the user names the crab the panel should behave normally on next open.
  if (window.Crab && window.Crab.endOnboarding) window.Crab.endOnboarding();
}

// Show a non-agent system line (e.g. a mic-permission hint) in the panel.
function systemNote(text) {
  if (!isOpen) open(window.Crab.getBbox());
  addMessage('crab', text);
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit(inputEl.value);
  } else if (e.key === 'Escape') {
    close();
  }
  e.stopPropagation();
});

// ---- Mic button (voice input) ----
// Reflect capture state on the button. Called by renderer/audio.js.
function setMicState(state) {
  if (!micBtn) return;
  micBtn.classList.toggle('recording', state === 'recording');
  micBtn.classList.toggle('busy', state === 'transcribing');
}

let micWarmed = false;
if (micBtn) {
  micBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!window.ClawdMic) return;
    // Already capturing → stop + transcribe.
    if (window.ClawdMic.isCapturing()) {
      window.ClawdMic.stop();
      return;
    }
    // Start: make sure we have mic permission, warm the model once, then capture.
    micBtn.classList.add('busy');
    let status = 'granted';
    try {
      if (window.crabAPI && window.crabAPI.requestMic) status = await window.crabAPI.requestMic();
    } catch (_) {}
    micBtn.classList.remove('busy');
    if (status !== 'granted') {
      systemNote('i need microphone access — turn it on in System Settings → Privacy & Security → Microphone, then tap the mic again.');
      return;
    }
    if (!micWarmed) {
      micWarmed = true;
      window.crabAPI && window.crabAPI.warmStt && window.crabAPI.warmStt();
    }
    window.ClawdMic.start();
  });
  // Don't let a mousedown on the button bubble to the document handler that
  // would otherwise treat it as an outside-click and close the chat.
  micBtn.addEventListener('mousedown', (e) => e.stopPropagation());
}

window.Chat = {
  open,
  close,
  submit,
  systemNote,
  setMicState,
  isBusy: () => inFlight,
  isOpen: () => isOpen,
  containsPoint(x, y) {
    if (!isOpen) return false;
    const r = chatEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  },
};
