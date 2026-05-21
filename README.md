# Clawd

A pixel-art crab pet that lives on your macOS desktop and is also Claude. Click him to chat. He can look at your screen, control Spotify, react when you switch apps, take naps when ignored, and walk around the bottom of whichever monitor you pick.

Powered by your Claude Pro or Max subscription via the Claude Agent SDK — **no API key, no per-token billing**.

---

## Install

Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
```

That's it. The installer:
- checks your machine meets the requirements
- pulls the source
- builds Clawd locally
- signs it with a local certificate
- installs it to `/Applications`

Takes 2–3 minutes the first time, ~30 seconds for subsequent reinstalls.

### First launch

macOS will block the first launch because Clawd isn't signed by an Apple Developer account. **One-time workaround:**

1. Open Finder → Applications
2. **Right-click `Clawd` → Open** (don't double-click)
3. Click **Open** in the Gatekeeper warning

After that, Clawd is trusted — Spotlight, Launchpad, double-click all work normally.

---

## Requirements

- **macOS on Apple Silicon** (M1 / M2 / M3 / M4) — well tested. Intel Macs should work too (the installer auto-detects arch and builds the right binary) but they're not tested yet.
- **Node.js 20+** — used to build Clawd. Install with `brew install node` or from <https://nodejs.org>.
- **Claude Pro or Max subscription.**
- **Claude Code installed, signed in** — install from <https://claude.com/code>, then run `claude login` in a terminal. Clawd won't be able to chat without this.
- **Optional:** Spotify desktop app, if you want Clawd to control music.

---

## Set up Claude (one-time)

Clawd uses your subscription instead of an API key. To wire it up:

1. Install Claude Code: <https://claude.com/code>
2. In any terminal:

   ```bash
   claude login
   ```

3. Sign in with your Claude Pro/Max account.

Now Clawd can chat. He reads the credentials Claude Code writes to `~/.claude/.credentials.json` — there's nothing to add to Clawd's config.

---

## Optional: Spotify auto-play

1. Click the **`clawd`** label in your macOS menubar (top-right area).
2. Pick **Connect Spotify…**
3. Browser opens to Spotify's authorization page. Sign in if needed, click **Agree**.
4. Browser shows "clawd is connected to spotify" — close the tab.

After that, ask Clawd things like "play hello by adele" and it just plays. (Spotify Premium users get a flash-free experience via the Spotify Web API; Free users fall back to AppleScript-controlled playback with focus restoration.)

The menubar item flips to **Disconnect Spotify** for whenever you want to revoke. Clawd never sees your password — it's a standard OAuth flow with the credential stored locally on your Mac.

---

## Granting Screen Recording

The first time Clawd peeks at your screen (`see_screen` / `see_window` tools), macOS pops a permission prompt.

1. Click Clawd → ask "what's on my screen?"
2. Click **Open System Settings** in the prompt
3. Toggle **Clawd** on under Privacy & Security → Screen Recording
4. **Quit Clawd via the menubar** (`clawd` → Quit Clawd) and relaunch — macOS only honors the new permission after a full restart.

Because the installer uses a stable self-signed certificate, this grant persists across future Clawd updates. You won't have to redo it.

---

## Using Clawd

Clawd walks back and forth along the bottom of one monitor. He mixes a few behaviors (walking, idle pauses, stretches, occasional fast scuttle bursts) and hops when you switch apps.

### Chatting

Click on Clawd → small chat panel opens above him. Type, hit Enter. Esc or click outside the panel to close.

### Things you can ask

- "what time is it"
- "what app am i in"
- "what's on my screen" — Clawd puts on reading glasses while he looks
- "read my chrome tab", "look at slack"
- "what's playing" — Clawd puts on headphones to check Spotify
- "pause", "skip", "previous track"
- "play [song or artist name]" — plays the first matching track if you've connected Spotify

Mundane questions ("what's 2+2") just stream back without any tool use.

### Tray menu

Click `clawd` in the macOS menubar. Options:

- **Reset conversation** — clears Clawd's memory of the current chat
- **Size →** — small / medium / large / huge
- **Move to monitor →** — pick which display Clawd lives on
- **Connect Spotify…** / **Disconnect Spotify**
- **Launch at login** — checkbox; toggle on to start Clawd every time you log in
- **Quit Clawd**

### When Clawd sleeps

After about 3 minutes of no chat interaction, Clawd dozes off — eyes closed, no walking, little `z` characters float up from his head. Click him or send a message and he wakes immediately.

---

## Updating Clawd

Run the installer again — it pulls the latest source and rebuilds:

```bash
curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
```

After updating, right-click → Open the first time because the signature changed.

## Uninstalling Clawd

```bash
pkill -f Clawd.app 2>/dev/null
rm -rf /Applications/Clawd.app
rm -rf "$HOME/Library/Application Support/Clawd"
rm -rf "$HOME/Library/Application Support/Clawd-src"
tccutil reset ScreenCapture dev.clawd.app 2>/dev/null
osascript -e 'tell application "System Events" to delete login item "Clawd"' 2>/dev/null
```

---

## Known limitations

- **macOS only.** AppleScript + Apple's `desktopCapturer` + macOS-specific tray behavior.
- **Not Apple-Developer-ID signed.** First-launch Gatekeeper warning still requires right-click → Open. Removing that requires a paid Apple Developer account ($99/yr).
- **Single monitor at a time.** Use the tray submenu to switch monitors.
- **Notification reactions are app-switch reactions.** macOS doesn't expose system notifications to apps without private APIs.

---

## For developers

Want to hack on Clawd? Clone manually and use the npm scripts:

```bash
git clone https://github.com/bournechoi4353/ClaudeBuddy.git
cd ClaudeBuddy
npm install
npm run setup-signing   # one-time, sets up the self-signed cert
npm start               # dev mode (Electron with hot file load)
npm run pack            # build Clawd.app into dist/mac-arm64/
```

Project structure:

- `main.js` — Electron main process: windows, tray, IPC, app-switch watcher.
- `preload.js` — secure bridge between renderer and main.
- `agent.js` — wraps the Claude Agent SDK with subscription auth.
- `tools.js` — tools Clawd can call (time, frontmost window, screen/window capture, Spotify).
- `spotify-auth.js` — OAuth Authorization Code + PKCE flow for Spotify connection.
- `renderer/crab.js` — the pixel-art crab, animation state machine, accessories.
- `renderer/chat.js` — chat panel UI.
- `scripts/generate-icon.js` — pure-JS PNG encoder that renders the crab into `build/icon.png`.
- `scripts/setup-self-signed.sh` — creates and trusts the self-signed code-signing cert.

See [CLAUDE.md](CLAUDE.md) for architectural notes useful when editing the codebase.
