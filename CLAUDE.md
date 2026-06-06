# CLAUDE.md

Context for future Claude sessions working on this codebase. End-user docs live in [README.md](README.md); this file is for editing the project.

## What this is

Clawd is a transparent always-on-top Electron app on **macOS and Windows**. It draws a small pixel-art crab on the user's screen who can chat, look at the screen, and control Spotify. The "AI" is the Claude Agent SDK driven by the user's **Claude Pro/Max subscription** (not an API key).

Single window, single monitor at a time. Click-through everywhere except the crab itself and the chat panel.

macOS is the primary, best-tested platform. Windows is supported via a small abstraction layer ([platform.js](platform.js)) plus `process.platform` guards in the existing files — Mac behavior is unchanged. See "Cross-platform (macOS + Windows)" below for what works, what degrades, and the conventions to follow when adding tools.

## File map

- **`main.js`** — Electron main: window, tray, IPC, app-switch watcher, prefs persistence, monitor picker.
- **`preload.js`** — contextBridge exposing `window.crabAPI` to the renderer. Only IPC surface.
- **`agent.js`** — wraps `@anthropic-ai/claude-agent-sdk`. Dynamic-imports it (ESM), holds session ID for multi-turn memory, emits chunks/tool events upstream.
- **`tools.js`** — the SDK tools Clawd can call. Many are macOS-specific (osascript / Spotify AppleScript); those are platform-guarded and degrade on Windows. Cross-platform tools (web search, weather, timers, clipboard, screen capture, Gmail/Drive/Docs, Spotify Web API) work everywhere.
- **`platform.js`** — cross-platform OS primitives shared by main.js + tools.js: `getFrontmostApp()`, `getFrontmostWindow()`, `getBattery()`, plus `IS_MAC`/`IS_WIN`. macOS path = `osascript`/`pmset`; Windows path = PowerShell (`-EncodedCommand`, UTF-16LE base64 to dodge quoting).
- **`renderer/crab.js`** — pure pixel-art crab, animation, behavior state machine, mouse hit-testing.
- **`renderer/chat.js`** — chat panel DOM logic.
- **`renderer/index.html`** — minimal canvas + chat panel.
- **`scripts/generate-icon.js`** — one-shot pure-JS PNG encoder that draws the crab at 1024×1024 into `build/icon.png`.

## Auth (read before touching agent.js)

The SDK reads `~/.claude/.credentials.json` — populated by `claude login` via Claude Code CLI. There is no other auth path here.

`main.js` explicitly deletes `ANTHROPIC_API_KEY` and all `CLAUDE_CODE_*` / `CLAUDECODE` / `AI_AGENT` env vars at startup. **Don't add an API-key fallback** — the whole point is that costs come out of the user's subscription, not their API spend.

The SDK errors with "[invalid_api_key]" or similar if the credentials file is missing. There's currently no startup check; failure surfaces in the chat panel as `[error: ...]`.

## SDK quirks (read before touching agent.js or package.json)

The `@anthropic-ai/claude-agent-sdk` package contains:

- ESM `.mjs` files (sdk.mjs, bridge.mjs, etc.) — must be loaded via dynamic `import()`, not `require()`.
- A 200 MB **Bun-compiled native binary** in a sibling package: `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (or `-x64` on Intel; `-win32-x64/claude.exe` on Windows). The SDK spawns this binary as a subprocess. These are `optionalDependencies` of the SDK keyed by os/cpu, so `npm install` only pulls the one matching the machine you install on — **to build the Windows installer you must run `npm install` on Windows** (or otherwise fetch `claude-agent-sdk-win32-x64`). `agent.js#resolveClaudeBinary()` already computes the right package + `claude.exe` name from `process.platform`/`process.arch`.

When packaged into the .app:

1. The binary must be **unpacked from asar** — spawn() can't traverse an asar archive (`ENOTDIR`). Handled by `asarUnpack` globs in `package.json`:
   - `**/node_modules/@anthropic-ai/claude-agent-sdk/**`
   - `**/node_modules/@anthropic-ai/claude-agent-sdk-*/**`
2. The SDK's internal `require.resolve` still returns the *asar* path even when the file is unpacked. We compute the real `app.asar.unpacked` path in `agent.js#resolveClaudeBinary()` and pass it as `options.pathToClaudeCodeExecutable` on every query. Don't remove this.
3. `zod` is a direct dependency in `package.json` — npm only flattens it to `node_modules/zod` because nothing else declares it directly. electron-builder wouldn't bundle it otherwise.

## Cross-platform (macOS + Windows)

The port is **additive**: every macOS code path is intact and untouched; Windows behavior is added beside it behind `process.platform` / `platform.IS_WIN` guards. No second fork — the same files build for both OSes.

**What runs everywhere:** chat (SDK), the crab renderer, the transparent click-through window, `now`, `web_search`, `weather`, timers, clipboard, `see_screen`/`see_window` (Electron `desktopCapturer`), Gmail/Drive/Docs (Google HTTP APIs), and `frontmost_window` (via [platform.js](platform.js)). Battery alerts and app-switch reactions/idle chatter also work on both (PowerShell on Windows).

**What degrades on Windows** (no clean equivalent yet → returns a short "mac-only" message via `tools.js#macOnly()`): `calendar_events` / `add_calendar_event` / `delete_calendar_event` (Calendar.app), `get_notes` / `save_note` (Notes.app), `get_recent_emails` / `search_emails` / `send_email` (Mail.app — Windows users use the Gmail tools instead), and `read_browser_tab` (Chrome/Safari AppleScript). The proactive Calendar nudge in `main.js#checkCalendarSoon()` is also macOS-gated.

**Spotify:** on macOS the control tools (`spotify_status`/`play_pause`/`next`/`previous`/`play_uri`/`search`) drive the desktop app via AppleScript, with `spotify_play` preferring the Web API and falling back to AppleScript. On Windows there's no AppleScript bridge, so those handlers route **entirely through the Spotify Web API** (`spotifyWebControl()` + helpers in tools.js) — which needs Premium and the desktop app open once as an active Connect device. `ensureSpotifyRunningHidden()` and `playViaAppleScript()` are macOS-gated.

**Conventions when adding a tool:**
- If it needs the foreground app/window or battery, call [platform.js](platform.js) — don't add a second `osascript` spawn.
- If it's inherently macOS-app-bound (AppleScript to some `.app`), guard with `if (!platform.IS_MAC) return macOnly('…')` at the top, and add the tool name to the `platformNote()` avoid-list in [agent.js](agent.js) so Claude steers clear on Windows. **`platformNote()` and any system-prompt string must never contain backticks** — they close the template literal and crash the app (build the note with single-quote concatenation).
- User-facing "where's the menu" strings use `TRAY_HINT` in tools.js (menubar on macOS, system-tray on Windows), not a hardcoded "menubar".
- New top-level source files must be added to `build.files` in `package.json` or electron-builder won't bundle them.

## macOS specifics

- Window is sized to `display.workArea` (not `display.bounds`) so the dock doesn't cover Clawd's legs. The dock renders above floating windows on macOS.
- `setAlwaysOnTop(true, 'screen-saver')` + `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.
- Click-through: `setIgnoreMouseEvents(true, { forward: true })` by default. The renderer hit-tests the cursor against the crab + chat panel every frame and toggles capture via `crabAPI.setIgnoreMouse`. The `forward: true` flag keeps mousemove events flowing even while click-through is on, which is what makes the hit-test possible.
- Tray uses `nativeImage.createEmpty()` + `setTitle('clawd')`. We don't have a real template image yet — text title is the click target.
- Dock icon hidden: `app.dock.hide()` + `skipTaskbar: true` on the window. Quit / config goes through the tray.
- Code signing is **ad-hoc** (no Developer ID). Every rebuild changes the binary hash, so macOS forgets Screen Recording permission. Lived-with limitation.

## Renderer architecture

The crab is a `string[]` (the `CRAB` constant). `O` = orange body, `X` = black eye, `.` = transparent. Each cell is rendered as a `SCALE × SCALE` `fillRect`. Don't introduce sprite sheets — the whole point is procedural pixels.

Accessories (glasses, headphones) are extra pixel arrays in `ACCESSORY_CELLS`, drawn on top of the crab. Triggered by `handleToolUse(toolName)` which is invoked when the SDK emits a `content_block_start` of type `tool_use`.

Animation is a behavior state machine (`ST.WALK`, `ST.SCUTTLE`, `ST.IDLE`, `ST.STRETCH`, `ST.BOUNCE_PAUSE`). State transitions and probabilities live in `pickNextBehavior()` at the top of `crab.js`. After IDLE/STRETCH/BOUNCE_PAUSE, Clawd has a 35% chance to flip direction; mid-walk he has a 25% chance to flip when picking the next walk segment.

`SCALE` is a `let`. The user changes it via the tray "Size →" submenu; the IPC `clawd-set-scale` lands on `applyScale()` in the renderer. Default 6, persisted in prefs.

Sleep: after `SLEEP_AFTER_MS` (3 min) of no chat interaction, Clawd dozes. `noteInteraction()` is called on chat open and on message send.

## Tools

All tools go through `createSdkMcpServer` + `tool()` from the agent SDK. Names follow `mcp__clawd__<tool_name>`. Allowed-tools list and tool definitions both live in `tools.js`; update both when adding a tool. System prompt in `agent.js` documents when to call which.

The `see_screen` and `see_window` tools call `assertScreenPermission()` first using `systemPreferences.getMediaAccessStatus('screen')` so we fail with a clear message when permission is missing, instead of sending Claude a black image.

`see_screen` sets `mainWin.setOpacity(0)` for 80ms before capture so Clawd doesn't end up in his own screenshot. `see_window` doesn't need this because it captures from window backing buffers, not the live screen.

## Prefs

`~/Library/Application Support/Clawd/prefs.json`. Currently stores:

- `scale` — number, set by tray "Size →" submenu, hot-reloaded via IPC.
- `spotifyRefreshToken` — written by the tray "Connect Spotify…" flow ([spotify-auth.js](spotify-auth.js)). Used by `spotify_play` to mint short-lived access tokens against the user's own Spotify account. Cleared by "Disconnect Spotify".

Add new keys here for any future persistent setting. `main.js` has `loadPrefs`/`savePrefs`; `tools.js` has its own `getPrefs` with a 5s cache so hand-edits to the file get picked up without restart.

## Build / test loop

Dev: `npm start`. From inside VS Code's terminal you must also strip `ELECTRON_RUN_AS_NODE`:

```
env -u ELECTRON_RUN_AS_NODE npm start
```

Outside VS Code this isn't needed.

Ship to the installed `/Applications/Clawd.app`:

```
npm run pack
rm -rf /Applications/Clawd.app
cp -R dist/mac-arm64/Clawd.app /Applications/
```

Then right-click → Open the first time (Gatekeeper, since the signature changed).

If see_screen stops working, reset its TCC entry:

```
tccutil reset ScreenCapture dev.clawd.app
```

**Windows** (run on a Windows machine — see SDK quirks about the native binary): `npm start` for dev, `npm run dist:win` for an NSIS installer into `dist\`. There's no code-signing/Gatekeeper step; SmartScreen may warn on first run of an unsigned build. `setup-signing` is macOS-only and not needed.

## Things tried and rolled back — don't redo without reason

- **Single window spanning all monitors via union bounding box.** macOS silently clips transparent + alwaysOnTop windows to the display they were created on, so Clawd was invisible past monitor 1. The segments-based per-monitor Y fix didn't help because the window itself was clipped.
- **Multi-window architecture (one window per monitor, IPC handoff).** Worked in principle but produced glitching with frozen ghost instances at handoff time, and chat lifecycle across windows was awkward. Reverted to single window with a "Move to monitor →" tray picker.
- **Real notification reactions via the macOS notification SQLite DB.** Requires Full Disk Access and is fragile across OS versions. We use frontmost-app polling as a substitute — Clawd hops when the user switches apps.
- ~~**Auto-play search results in Spotify.**~~ Implemented via Spotify OAuth Authorization Code + PKCE. The flow: tray "Connect Spotify…" → local HTTP server on 127.0.0.1:8888 → browser redirect to Spotify → user authorizes → server captures code → token exchange → refresh_token persisted in prefs.json. Search uses the user's own Spotify quota. Playback still goes through local Spotify desktop app via AppleScript. The client_id is embedded in [spotify-auth.js](spotify-auth.js); PKCE means no client secret is needed.

## Conventions

- System prompt enforces Clawd's voice: lowercase, 1–2 short sentences, no emojis, no markdown. Don't relax this — UI is a 240px chat bubble.
- No emojis in any project files or UI unless the user explicitly asks.
- Don't add error handling for impossible cases. Trust the framework.
- Don't introduce dependencies casually — every package adds to the .app's 400 MB footprint and to the rebuild surface.
