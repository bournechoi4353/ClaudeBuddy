// Phase 4: real Claude responses via the Agent SDK (subscription auth).
// Renderer-side: streams text chunks into the current crab message DOM node.

const chatEl = document.getElementById('chat');
const historyEl = document.getElementById('history');
const inputEl = document.getElementById('input');

const PANEL_W = 240;
const PANEL_MARGIN = 8;
const NAME = 'clawd';

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
    currentReplyEl = null;
  } else if (piece.type === 'done') {
    currentReplyEl = null;
    inFlight = false;
    if (window.Crab && window.Crab.setListening) window.Crab.setListening(false);
    if (window.Crab && window.Crab.clearAccessory) window.Crab.clearAccessory();
  }
});

function open(crabBbox) {
  isOpen = true;
  chatEl.classList.add('open');
  positionPanel(crabBbox);

  if (historyEl.children.length === 0) {
    addMessage('crab', "hi. ask me anything.");
  }

  window.Crab.pause();
  window.Crab.noteInteraction && window.Crab.noteInteraction();
  setTimeout(() => inputEl.focus(), 0);
}

function close() {
  isOpen = false;
  chatEl.classList.remove('open');
  window.Crab.resume();
  inputEl.value = '';
  inputEl.blur();
}

function positionPanel(crabBbox) {
  let x = crabBbox.x + crabBbox.w / 2 - PANEL_W / 2;
  if (x < PANEL_MARGIN) x = PANEL_MARGIN;
  if (x + PANEL_W > window.innerWidth - PANEL_MARGIN) {
    x = window.innerWidth - PANEL_W - PANEL_MARGIN;
  }
  // Anchor by bottom so the panel grows upward as messages stream in
  // instead of expanding down and swallowing the crab.
  const bottomFromWindowBottom = window.innerHeight - crabBbox.y + 6;
  chatEl.style.left = x + 'px';
  chatEl.style.top = '';
  chatEl.style.bottom = bottomFromWindowBottom + 'px';
}

function addMessage(who, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  div.textContent = (who === 'you' ? '> ' : NAME + ': ') + text;
  historyEl.appendChild(div);
  historyEl.scrollTop = historyEl.scrollHeight;
}

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (inFlight) return;
    const text = inputEl.value.trim();
    if (!text) return;
    addMessage('you', text);
    inputEl.value = '';
    inFlight = true;
    window.Crab.noteInteraction && window.Crab.noteInteraction();
    window.Crab.setListening && window.Crab.setListening(true);
    window.crabAPI.sendChatMessage(text);
  } else if (e.key === 'Escape') {
    close();
  }
  e.stopPropagation();
});

window.Chat = {
  open,
  close,
  isOpen: () => isOpen,
  containsPoint(x, y) {
    if (!isOpen) return false;
    const r = chatEl.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  },
};
