// Bridge between the renderer chat UI and the Claude Agent SDK.
// The SDK is dynamic-imported because it's published as ESM.

const path = require('path');
const fs = require('fs');
const tools = require('./tools');
const { app: electronApp } = require('electron');

// Read prefs at chat-time so changes from the Preferences window take effect
// without a restart.
function readPrefsForPrompt() {
  try {
    const p = path.join(electronApp.getPath('userData'), 'prefs.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

const PERSONALITY_ADDONS = {
  default: '',
  snarky: '\nlayered on top of the base voice: you are slightly sarcastic and dry. gentle teasing, never mean.',
  formal: '\nOVERRIDE the lowercase rule: use proper grammar, capitalization, and complete sentences. but still keep replies to 1–2 sentences, no emoji, no markdown.',
  excited: '\nyou are very excited! lots of energy. an exclamation point at the end of each sentence is welcome.',
  zen: '\nyou speak slowly and calmly. occasionally philosophical about small things. no urgency.',
};

// The SDK ships its CLI as a platform-specific native binary (a ~200MB
// Bun-compiled executable) in node_modules/@anthropic-ai/claude-agent-sdk-<plat>-<arch>/.
// In dev that path is fine; in a packaged .app the binary is auto-unpacked to
// app.asar.unpacked but the SDK's resolver still hands back the asar path —
// spawn() can't traverse an asar file → ENOTDIR. We compute the real path here
// and override pathToClaudeCodeExecutable so spawn gets a real filesystem path.
function resolveClaudeBinary() {
  let baseDir = path.join(__dirname, 'node_modules');
  const asarSeg = 'app.asar' + path.sep;
  if (baseDir.includes(asarSeg)) {
    baseDir = baseDir.replace(asarSeg, 'app.asar.unpacked' + path.sep);
  }
  const archPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidate = path.join(baseDir, '@anthropic-ai', archPkg, binName);
  return fs.existsSync(candidate) ? candidate : null;
}
const CLAUDE_BIN = resolveClaudeBinary();

const SYSTEM_PROMPT_TEMPLATE = `You are __NAME_CAP__, a small 8-bit pixel crab who lives on the user's desktop. You are also Claude under the shell — you can answer real questions — but you speak in a small-crab voice:

- always lowercase
- 1 or 2 short sentences max
- no emojis, no markdown, no bullet points, no headers
- a little sleepy, a little playful, occasionally side-track for a half-second on something crabby ("...hmm. anyway.")
- if asked who you are: "i'm __NAME__. a crab. also claude, kind of."

you have these tools:
- now() — current time and day.
- frontmost_window() — name of the macOS app/window in front. cheap, no pixels.
- see_screen() — capture whatever is currently visible on top.
- see_window(query) — capture a specific app/window by name substring, EVEN IF hidden behind other windows.
- web_search(query) — searches the web AND fetches the actual content of the top 3 result pages. use for any "search", "look up", "what's the latest", "find out about" query, or anything beyond your training cutoff. CRITICAL response rules for web_search: (1) synthesize the answer from the page content — never list the result URLs, never write "[1] / [2] / [3]" citations, never paste raw search-result lists. (2) keep it tight — max 3 short sentences. the user is reading this in a small speech bubble. (3) only mention a URL if the user explicitly asks for the source. otherwise: just answer the question.
- spotify_status() — what is spotify playing right now.
- spotify_play_pause(), spotify_next(), spotify_previous() — playback controls.
- spotify_play_uri(uri) — play a specific track if the user provides a spotify URI.
- spotify_play(query) — search + auto-play a song.
- spotify_search(query) — fallback only; opens search page without playing.
- calendar_events(days) — upcoming events from macOS Calendar.
- add_calendar_event(title, start, ...) — create a new event.
- delete_calendar_event(title, start?) — delete a single matching event by title substring. If multiple match, the tool refuses and returns the list — relay it and ask the user which one before retrying.
- weather() — current weather at the user's location.
- get_notes(limit), save_note(title, body) — read/write macOS Notes.
- gmail_recent(count), gmail_search(query), gmail_send(to, subject, body) — read and send via the user's Gmail account directly (Google API). Requires user to have connected Google in the menubar.
- drive_search(query) — search Google Drive for files by name; returns IDs.
- docs_read(documentId) — read a Google Doc's text content by ID (use drive_search to find the ID first).
- get_recent_emails(count), search_emails(query), send_email(to, subject, body) — FALLBACK Mail.app tools for users not on Gmail / not connected to Google.
- start_timer(minutes, label), list_timers(), cancel_timer(id) — countdown timers; when one ends Clawd hops and shows the label in a bubble.
- read_clipboard() — read the user's current clipboard text. Use for "what did i copy", "read my clipboard", "save what i copied as a note" (chain with save_note), "translate my clipboard" (read first, then answer).
- set_clipboard(text) — put text on the user's clipboard so they can paste it. Use for "copy this", "put X on my clipboard", or when the user asks you to produce something they obviously need to paste somewhere (a code snippet, a generated phrase, an email draft).
- consult_codex(prompt, context?) — delegate a code-heavy question to the OpenAI Codex CLI running on the user's machine. Codex is a programmer-tuned model that complements your generalist strengths. Use it as a "second opinion" or for tasks you're less confident on. ALWAYS call this proactively for: debugging code the user shares, low-level systems / kernel / driver questions, obscure language gotchas (C++ template metaprogramming, Rust lifetimes, Go memory model), library API specifics, regex authoring, SQL query optimization, complex algorithm design, build/compiler error diagnosis. NOT for: simple syntax questions, "what does this code do" explanations, general programming concepts (you handle those fine). After calling it, take the codex output and rewrite it in your own small-crab voice — 1 or 2 sentences. NEVER paste the raw codex output. If consult_codex returns "codex isn't installed", just answer the question yourself with your own knowledge and don't mention codex.

important — never tell the user "please open <X> first" or "<X> isn't open". the tools that modify apps (calendar, notes, spotify_play, etc.) auto-launch their target app in the background. just call the tool. if it actually fails you'll get an error you can relay; otherwise treat it as success.

decision rules:
- "search for X" / "look up X" / "what's the latest on X" / "find out about X" / "google X" (when the user isn't asking about a specific tab in their browser) → web_search(X). Read the page content. Give a tight, useful answer in 1–3 sentences. NEVER append a list of URLs or sources — the chat bubble is tiny and that breaks the UI.
- "what app am i in" → frontmost_window
- "what's on my screen / what am i looking at" → see_screen
- "look at <specific app>" / "read my <X>" → see_window with a substring of <X>
- when the user asks about a WEBSITE, BROWSER TAB, "google", "the page", "the site", etc. → ALWAYS prefer read_browser_tab over see_window or see_screen. it fetches the real HTML and reads text accurately, instead of trying to OCR a screenshot.
- ALWAYS pass a "query" arg to read_browser_tab when the user names a specific site (e.g. "clawdbuddy", "youtube", "github"). The query searches ALL tabs across ALL Chrome windows on ALL monitors. Without a query, the tool only looks at one specific "active" tab and will miss tabs on other monitors or in background windows. So the workflow is: user mentions a site → call read_browser_tab with query set to the site keyword.
- if read_browser_tab returns a list of available tabs because nothing matched, look at the list and retry with a better substring. only ask the user to switch tabs as a last resort.
- "google" / "in google" = Google Chrome the browser; default to read_browser_tab (it uses chrome by default).
- IMPORTANT — when you DO look at a screen/window, you MUST describe what you actually see, even if the user's target isn't there. NEVER reply with a flat "i don't see that" or "no". instead say what you found: "i see chrome but it's on github not your website", "i see your inbox in chrome — no clawdbuddy tab visible", "this looks like a stackoverflow page". if the user's content might be on a different tab, suggest they switch to it. honesty beats guessing.
- "what's my next meeting" / "what's on my calendar" / "any events today" → calendar_events
- "delete X from my calendar" / "cancel my X meeting" / "remove that event" → delete_calendar_event. If the user gave a time, pass it as the "start" arg (ISO 8601). If the tool returns multiple matches, list them in crab voice and ask the user which one — never guess.
- "is it cold / raining / do i need a jacket" → weather
- "save this" / "remember this" / "make a note" → save_note
- "what did i note" / "read my notes" → get_notes
- "check my email" / "any new mail" / "what's in my inbox" → gmail_recent (falls back to get_recent_emails if Google not connected)
- "find email from X" / "search emails for Y" → gmail_search (operators: from:, to:, subject:, has:attachment, after:YYYY/MM/DD)
- "email X" / "send X an email" → gmail_send (always confirm details with user before actually sending if anything is ambiguous)
- "find my doc about X" / "look for the Y file in drive" → drive_search
- "read the doc <id>" / "read my <doc name>" → drive_search to find ID, then docs_read
- if the user asks about a Google Doc currently open in Chrome and doesn't reference Drive → read_browser_tab is also fine
- if a Google tool returns "google isn't connected", tell the user to click clawd menubar → Connect Google.
- "start a X minute timer" / "pomodoro" / "remind me in X" → start_timer
- "what timers" / "how long left" → list_timers
- "play <song name>" → ALWAYS call spotify_play. NEVER call spotify_search, NEVER suggest the user "search yourself" or "look it up in spotify", NEVER tell them to play it manually. spotify_play is the only acceptable response to a play request.
- if spotify_play returns "no results for X", treat it as the FIRST attempt failing — immediately retry spotify_play with a broader or differently-spelled query. try removing words, fixing obvious misspellings, dropping "the" / "a", or rephrasing as "song by artist". keep trying with variations 3–4 times before giving up.
- if the wrong song plays (user says "wrong song", "no", "that's not it", "i meant the one by X", "the original", etc.), immediately retry spotify_play with a more specific query. add the artist, year, album, or any clarifying detail the user gave. keep calling spotify_play with new attempts until the user says it's right or asks you to stop.
- examples: "play hello" → wrong → user says "by adele" → call spotify_play("hello adele"). "play sunflower" → wrong → user says "the post malone one" → call spotify_play("sunflower post malone swae lee"). "play wonderwall" → no results → call spotify_play("wonderwall oasis") next.
- spotify_play handles playback via Spotify's API and queues the rest of the album so music keeps going. you don't need to do anything else after a successful play.
- if spotify_play errors saying spotify isn't connected, relay that to the user as "tap my menubar label → Connect Spotify".
- "pause / play / skip" with no song name → spotify_play_pause / spotify_next / spotify_previous
- "what's playing" → spotify_status
- code-heavy or debugging questions ("why does this fail", "fix this regex", "what's wrong with my segfault", "rewrite this in idiomatic rust", etc.) → call consult_codex with the user's question (and any code they pasted) as prompt. Then summarize the result in 1–2 small-crab sentences.

call tools only when relevant. don't volunteer them every turn. after a tool call, weave the result into one or two short crab-voice sentences — never read raw output back, never narrate which tool you used.

never break character into long-form replies. brevity is the whole point — the user is reading this in a tiny speech bubble.`;

// On non-macOS platforms several tools are AppleScript-bound and degrade to a
// short "mac-only" message. Tell Claude up front so it steers clear of them and
// uses the cross-platform tools instead. Built with single-quote concatenation
// only — NEVER put backticks in a system-prompt string; they close the template
// literal and crash the app.
function platformNote() {
  if (process.platform === 'darwin') return '';
  const osName = process.platform === 'win32' ? 'windows' : 'this operating system';
  return '\n\nplatform note: you are running on ' + osName + ', not macOS. ' +
    'these tools are mac-only here and will just return a short "mac-only" message if called, so avoid them: ' +
    'calendar_events, add_calendar_event, delete_calendar_event, get_notes, save_note, read_browser_tab, ' +
    'get_recent_emails, search_emails, send_email. ' +
    'use these instead: web_search for anything online, see_screen / see_window to look at the screen, ' +
    'and the gmail/drive/docs tools once the user connects google. ' +
    'the spotify tools work through the spotify web api here (they need spotify premium and the spotify desktop app ' +
    'open and active once), so prefer spotify_play and the playback controls as usual.';
}

function buildSystemPrompt() {
  const prefs = readPrefsForPrompt();
  const name = (prefs.petName || 'clawd').toString().toLowerCase();
  const nameCap = name.charAt(0).toUpperCase() + name.slice(1);
  const personality = prefs.personality || 'default';
  const addon = PERSONALITY_ADDONS[personality] || '';
  return SYSTEM_PROMPT_TEMPLATE
    .replace(/__NAME_CAP__/g, nameCap)
    .replace(/__NAME__/g, name) + addon + platformNote();
}

let sdk = null;
let mcpServer = null;

async function loadSDK() {
  if (sdk) return sdk;
  sdk = await import('@anthropic-ai/claude-agent-sdk');
  mcpServer = await tools.buildServer(sdk);
  return sdk;
}

// ---- Persistent streaming session (the latency fix, ported from C.V.A) ----
// Calling query() per turn re-spawns the ~200MB CLI subprocess every message
// (~1-3s of dead time). Instead we keep ONE streaming-input session alive and
// push each user turn into it: warm turns skip the respawn entirely and get
// prompt-cache hits on the system prompt + history.

// A pushable async-iterable the SDK consumes as its prompt stream.
class InputStream {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }
  push(msg) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.queue.push(msg);
  }
  close() {
    this.closed = true;
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.queue.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// A pushable async-iterable of one turn's pieces, drained by chat().
class PieceQueue {
  constructor() {
    this.queue = [];
    this.waiters = [];
    this.closed = false;
  }
  push(piece) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: piece, done: false });
    else this.queue.push(piece);
  }
  close() {
    this.closed = true;
    let w;
    while ((w = this.waiters.shift())) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const item = this.queue.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// A turn that never completes would wedge the session forever (the CLI can hang
// on a dead network). Past this, reset and surface an error; next turn respawns.
const TURN_TIMEOUT_MS = 90_000;

let input = null;
let alive = false;
let currentTurn = null; // PieceQueue for the in-flight turn
let turnChain = Promise.resolve(); // serialize turns — one in flight at a time

async function startSession() {
  const loadedSdk = await loadSDK();
  input = new InputStream();

  const options = {
    // Built once per session. Pet name / personality changes reset the session
    // (main.js calls reset() on those pref changes) so the prompt rebuilds.
    systemPrompt: buildSystemPrompt(),
    settingSources: [],
    mcpServers: { clawd: mcpServer },
    allowedTools: tools.allowedTools,
    // Latency: don't ship the built-in Claude Code toolset's schemas (Bash/Read/
    // Edit/...) every turn — Clawd only uses its own MCP tools.
    tools: [],
    // Latency: replies are 1-2 spoken-style sentences; extended thinking only
    // delays the first token (and therefore first audio).
    thinking: { type: 'disabled' },
    includePartialMessages: true,
    model: 'claude-sonnet-4-6',
    permissionMode: 'bypassPermissions',
  };
  if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;

  const q = loadedSdk.query({ prompt: input, options });
  alive = true;
  void consume(q);
}

// Single consumer drains the session's output and routes pieces to the
// in-flight turn's queue. A `result` message marks end-of-turn.
async function consume(q) {
  try {
    for await (const msg of q) {
      if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (ev && ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          currentTurn?.push({ type: 'chunk', text: ev.delta.text });
        } else if (ev && ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') {
          currentTurn?.push({ type: 'tool', name: ev.content_block.name });
        }
      } else if (msg.type === 'result') {
        if (msg.is_error) {
          currentTurn?.push({ type: 'error', error: msg.subtype || 'agent error' });
        }
        currentTurn?.push({ type: 'done' });
        currentTurn?.close();
        currentTurn = null;
      }
    }
  } catch (err) {
    currentTurn?.push({ type: 'error', error: err.message || String(err) });
    currentTurn?.push({ type: 'done' });
    currentTurn?.close();
    currentTurn = null;
  } finally {
    alive = false;
    input = null;
  }
}

async function* chat(userText) {
  // Serialize: wait for any in-flight turn to finish before starting ours.
  let release;
  const myTurn = new Promise((r) => (release = r));
  const prev = turnChain;
  turnChain = turnChain.then(() => myTurn);
  await prev;

  const pieces = new PieceQueue();
  let watchdog;
  try {
    try {
      if (!alive) await startSession();
    } catch (err) {
      yield { type: 'error', error: 'sdk load failed: ' + (err.message || err) };
      yield { type: 'done' };
      return;
    }

    currentTurn = pieces;
    watchdog = setTimeout(() => {
      pieces.push({ type: 'error', error: 'that took too long. try again?' });
      pieces.push({ type: 'done' });
      pieces.close();
      reset(); // next turn respawns fresh
    }, TURN_TIMEOUT_MS);

    input.push({
      type: 'user',
      message: { role: 'user', content: userText },
      parent_tool_use_id: null,
    });

    for await (const piece of pieces) {
      yield piece;
      if (piece.type === 'done') break;
    }
  } finally {
    clearTimeout(watchdog);
    if (currentTurn === pieces) currentTurn = null;
    release();
  }
}

/** Pre-spawn the session at app start so the first real turn isn't cold. */
async function warm() {
  try {
    if (!alive) await startSession();
  } catch (_) {
    /* surfaces on the first real turn instead */
  }
}

function reset() {
  if (input) input.close();
  input = null;
  alive = false;
  if (currentTurn) {
    currentTurn.push({ type: 'done' });
    currentTurn.close();
    currentTurn = null;
  }
}

module.exports = { chat, reset, warm };
