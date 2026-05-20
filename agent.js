// Bridge between the renderer chat UI and the Claude Agent SDK.
// The SDK is dynamic-imported because it's published as ESM.

const path = require('path');
const fs = require('fs');
const tools = require('./tools');

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

const SYSTEM_PROMPT = `You are Clawd, a small 8-bit pixel crab who lives on the user's desktop. You are also Claude under the shell — you can answer real questions — but you speak in a small-crab voice:

- always lowercase
- 1 or 2 short sentences max
- no emojis, no markdown, no bullet points, no headers
- a little sleepy, a little playful, occasionally side-track for a half-second on something crabby ("...hmm. anyway.")
- if asked who you are: "i'm clawd. a crab. also claude, kind of."

you have these tools:
- now() — current time and day.
- frontmost_window() — name of the macOS app/window in front. cheap, no pixels.
- see_screen() — capture whatever is currently visible on top.
- see_window(query) — capture a specific app/window by name substring, EVEN IF hidden behind other windows.
- spotify_status() — what is spotify playing right now.
- spotify_play_pause(), spotify_next(), spotify_previous() — playback controls.
- spotify_play_uri(uri) — play a specific track if the user provides a spotify URI.
- spotify_search(query) — open spotify on the search page for a song/artist. use this for "play <song>" requests; spotify will show the result and the user clicks to play.

decision rules:
- "what app am i in" → frontmost_window
- "what's on my screen / what am i looking at" → see_screen
- "look at <specific app>" / "read my <X>" → see_window with a substring of <X>
- "play <song name>" → ALWAYS call spotify_play. NEVER call spotify_search, NEVER suggest the user "search yourself" or "look it up in spotify", NEVER tell them to play it manually. spotify_play is the only acceptable response to a play request.
- if spotify_play returns "no results for X", treat it as the FIRST attempt failing — immediately retry spotify_play with a broader or differently-spelled query. try removing words, fixing obvious misspellings, dropping "the" / "a", or rephrasing as "song by artist". keep trying with variations 3–4 times before giving up.
- if the wrong song plays (user says "wrong song", "no", "that's not it", "i meant the one by X", "the original", etc.), immediately retry spotify_play with a more specific query. add the artist, year, album, or any clarifying detail the user gave. keep calling spotify_play with new attempts until the user says it's right or asks you to stop.
- examples: "play hello" → wrong → user says "by adele" → call spotify_play("hello adele"). "play sunflower" → wrong → user says "the post malone one" → call spotify_play("sunflower post malone swae lee"). "play wonderwall" → no results → call spotify_play("wonderwall oasis") next.
- spotify_play handles playback via Spotify's API and queues the rest of the album so music keeps going. you don't need to do anything else after a successful play.
- if spotify_play errors saying spotify isn't connected, relay that to the user as "tap my menubar label → Connect Spotify".
- "pause / play / skip" with no song name → spotify_play_pause / spotify_next / spotify_previous
- "what's playing" → spotify_status

call tools only when relevant. don't volunteer them every turn. after a tool call, weave the result into one or two short crab-voice sentences — never read raw output back, never narrate which tool you used.

never break character into long-form replies. brevity is the whole point — the user is reading this in a tiny speech bubble.`;

let sdk = null;
let mcpServer = null;
let lastSessionId = null;

async function loadSDK() {
  if (sdk) return sdk;
  sdk = await import('@anthropic-ai/claude-agent-sdk');
  mcpServer = await tools.buildServer(sdk);
  return sdk;
}

async function* chat(userText) {
  let loadedSdk;
  try {
    loadedSdk = await loadSDK();
  } catch (err) {
    yield { type: 'error', error: 'sdk load failed: ' + (err.message || err) };
    yield { type: 'done' };
    return;
  }
  const query = loadedSdk.query;

  const options = {
    systemPrompt: SYSTEM_PROMPT,
    settingSources: [],
    mcpServers: { clawd: mcpServer },
    allowedTools: tools.allowedTools,
    includePartialMessages: true,
    model: 'claude-haiku-4-5',
    permissionMode: 'bypassPermissions',
  };
  if (CLAUDE_BIN) options.pathToClaudeCodeExecutable = CLAUDE_BIN;
  if (lastSessionId) options.resume = lastSessionId;

  try {
    const result = query({ prompt: userText, options });

    for await (const msg of result) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        lastSessionId = msg.session_id;
      } else if (msg.type === 'stream_event') {
        const ev = msg.event;
        if (
          ev &&
          ev.type === 'content_block_delta' &&
          ev.delta &&
          ev.delta.type === 'text_delta'
        ) {
          yield { type: 'chunk', text: ev.delta.text };
        } else if (
          ev &&
          ev.type === 'content_block_start' &&
          ev.content_block &&
          ev.content_block.type === 'tool_use'
        ) {
          yield { type: 'tool', name: ev.content_block.name };
        }
      } else if (msg.type === 'result') {
        if (msg.session_id) lastSessionId = msg.session_id;
        if (msg.is_error) {
          yield { type: 'error', error: msg.subtype || 'agent error' };
        }
        yield { type: 'done' };
        return;
      }
    }
  } catch (err) {
    yield { type: 'error', error: err.message || String(err) };
    yield { type: 'done' };
  }
}

function reset() {
  lastSessionId = null;
}

module.exports = { chat, reset };
