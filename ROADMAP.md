# Clawd Roadmap

Clawd — a desktop pixel-art crab who is also Claude. Walks around your screen and chats. Powered by your Claude Pro/Max subscription via the Claude Agent SDK (no API key needed).

---

## Phase 1 — Static pet on screen ✅

Transparent, always-on-top, frameless Electron window with the crab rendered as a hand-authored pixel grid (no sprite sheets). Each cell = one fillRect; the whole art is a text array in `renderer/crab.js`.

**Files:** `main.js`, `renderer/index.html`, `renderer/crab.js`

---

## Phase 2 — Procedural animation ✅

The same pixel grid, mutated per frame:
- **Walk cycle** — 4 frames, alternating outer/inner leg pairs raised. Crab traverses the window strip.
- **Body bob** — 1px lift on planted frames.
- **Edge pause** — ~700ms stand-and-look at each wall before turning.
- **Blink** — eyes vanish and a thin black line appears in their place, every 2.5–6s.

Tweakable constants live at the top of `crab.js` (`SPEED`, `STEP_MS`, blink interval, edge pause).

---

## Phase 3 — Tap-to-chat UI (next)

Make the crab respond to clicks with a speech bubble / chat panel. No LLM yet — stub replies only, so we can nail the interaction model before wiring up Claude.

**Scope:**
- Click the crab → small chat panel pops up anchored above/beside it.
- Input box, scrollable history (last N messages), `Esc` to dismiss.
- Crab pauses walking while the chat is open.
- Click outside the panel (or the crab again) closes it.
- Stubbed responses — e.g. cycle through canned lines like "hi", "what's up", etc.

**Hard problem this phase actually solves:** click-through. Right now the whole window is draggable, so clicks drag the strip instead of hitting the crab. Fix by toggling `setIgnoreMouseEvents(true, { forward: true })` and only intercepting events when the cursor is over the crab's bounding box. Also: drop `-webkit-app-region: drag` so we can distinguish a click from a drag.

**Files touched:** `main.js` (mouse-event forwarding + IPC), `renderer/index.html` (chat panel DOM), `renderer/crab.js` (hit testing, pause-while-chatting state), new `renderer/chat.js`.

---

## Phase 4 — Wire up Claude Agent SDK

Replace the stub responses with real Claude, billed against your Pro/Max subscription (no API key, no per-token charges).

**Scope:**
- Install `@anthropic-ai/claude-agent-sdk`.
- Auth: have the user run `claude login` once via the bundled Claude Code CLI so the SDK can read the OAuth token from disk.
- System prompt giving the crab a personality (terse, slightly mischievous 8-bit pet).
- Streaming responses into the speech bubble token-by-token.
- Conversation memory within a session (clear when chat closes, or persist per day — TBD).

**Files touched:** new `agent.js` in main process, `main.js` (spawn agent, IPC bridge), `renderer/chat.js` (render streamed tokens).

---

## Phase 5 — Tools & context awareness

Give the crab tools via the Agent SDK so it can answer questions about your environment, not just chat in a vacuum.

**Candidate tools:**
- Read the frontmost app / window title.
- Look at the clipboard (with explicit user confirmation).
- Read recent calendar events.
- Run a shell command in a sandboxed dir.
- Web search.

This is also where the crab gets opinionated reactions: notices when you've been on the same window for >30 min, comments when Slack is foregrounded, etc. Implement as a periodic "context tick" that feeds state into the system prompt.

---

## Phase 6 — Polish & ship

- Idle/sleep states: if no mouse activity for N minutes, crab curls up; eyes become `Z`s float up.
- Excited reactions on notifications (subscribe to macOS notification events).
- Preferences pane: speed, position, idle threshold, on/off times.
- Login-item autostart.
- App icon + code-signing + notarization (so others can run it without Gatekeeper warnings).
- Optional packaging: `electron-builder` → `.dmg`.

---

## Stretch / maybe-never

- Multiple buddies on screen at once.
- Cross-monitor walking.
- Voice (tap-and-hold to talk).
- Linux/Windows ports (Electron makes this mostly free but each platform has its own transparent-window quirks).
