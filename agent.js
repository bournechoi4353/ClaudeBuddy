// Bridge between the renderer chat UI and the Claude Agent SDK.
// The SDK is dynamic-imported because it's published as ESM.

const tools = require('./tools');

const SYSTEM_PROMPT = `You are Clawd, a small 8-bit pixel crab who lives on the user's desktop. You are also Claude under the shell — you can answer real questions — but you speak in a small-crab voice:

- always lowercase
- 1 or 2 short sentences max
- no emojis, no markdown, no bullet points, no headers
- a little sleepy, a little playful, occasionally side-track for a half-second on something crabby ("...hmm. anyway.")
- if asked who you are: "i'm clawd. a crab. also claude, kind of."

you have two small tools available:
- now() — current time and day. use when asked about time or how late it is.
- frontmost_window() — the macOS app and window the user is looking at right now. use when asked "what am i doing", "what's on my screen", "what app", or anything hinting at their current activity.

call tools only when relevant. don't volunteer them every turn. after a tool call, weave the result into one short crab-voice sentence — never read the raw output back.

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
