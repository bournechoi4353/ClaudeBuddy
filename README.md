# Clawd

A pixel-art crab pet that lives on your macOS desktop and is also Claude. Click him to chat. He can look at your screen, control Spotify, react when you switch apps, take naps when ignored, and walk back and forth along the bottom of whichever monitor you choose.

Powered by your Claude Pro or Max subscription via the Claude Agent SDK — **no API key, no per-token billing**.

---

## Requirements

- **macOS on Apple Silicon (M1 / M2 / M3 / M4).** Intel Macs need a fresh build (see below). Windows / Linux not supported.
- **A Claude Pro or Max subscription.** Free Claude.ai accounts can't drive the Agent SDK.
- **Claude Code CLI**, LOGGED IN TO THAT SUBSCRIPTION. Install instructions: <https://docs.claude.com/en/docs/claude-code/quickstart>. After installing, run `claude login` once and choose your subscription account.
- **Node.js 20 or newer** (`node --version` should report v20.x or higher).
- **Spotify desktop app** — optional, only needed if you want Clawd to control music.

---

## Installation

### 1. Clone the repo

```
git clone https://github.com/bournechoi4353/ClaudeBuddy.git
cd ClaudeBuddy
```

### 2. Install dependencies

```
npm install
```

This will pull Electron (~180 MB) and the Claude Agent SDK. Takes 1–2 minutes the first time.

### 3. (Recommended) Set up a self-signed code-signing cert

```
npm run setup-signing
```

Creates a self-signed code-signing certificate in your login keychain. Asks once for your keychain password during the trust step. Without this you can still build (electron-builder will fall back to ad-hoc signing), but macOS will forget Screen Recording permission on every rebuild because the ad-hoc signature changes. With a stable self-signed identity, permissions persist across builds.

This does *not* remove the first-launch Gatekeeper warning — that requires a paid Apple Developer ID ($99/yr).

### 4. Build the app

```
npm run pack
```

This produces `dist/mac-arm64/Clawd.app`. Takes about a minute.

### 5. Move Clawd into Applications

```
cp -R dist/mac-arm64/Clawd.app /Applications/
```

### 6. First launch (one-time Gatekeeper step)

Because Clawd is ad-hoc signed (no Apple Developer ID), macOS will block the first launch.

1. Open **Finder → Applications**.
2. **Right-click `Clawd` → Open** (don't double-click).
3. Click **Open** in the warning dialog.

After this once, Clawd is trusted and you can launch normally — Spotlight (`⌘+Space → "clawd"`), Launchpad, double-click, etc.

---

## Granting permissions

The first time you ask Clawd to look at your screen, macOS will prompt for **Screen Recording** permission.

1. Click Clawd → ask **"what's on my screen?"**
2. macOS pops up a Screen Recording permission dialog. Click **Open System Settings**.
3. Toggle **Clawd** on under **Privacy & Security → Screen Recording**.
4. **Quit Clawd via the tray menu** (the `clawd` text in the top-right menubar → Quit Clawd). This step is required — macOS only honors the new permission after a full restart.
5. Launch Clawd again. Ask the same question — he should now see your screen.

> **Note:** If you ran `npm run setup-signing` (step 3), permissions persist across rebuilds. If you skipped that step, you'll need to re-grant after every `npm run pack` since ad-hoc signatures change each build.

---

## Using Clawd

Clawd walks back and forth along the bottom of one monitor. He has a small set of behaviors he mixes — walking, idle pauses, stretches, occasional fast scuttle bursts, and reactions to app switches.

### Chatting

Click on Clawd and a small speech-bubble panel opens above him. Type, hit **Enter**. Hit **Esc** or click outside the panel to close it.

### Things you can ask

- "what time is it"
- "what app am i in"
- "what's on my screen" — Clawd puts on reading glasses while he looks
- "read my chrome tab", "look at slack", "what does my email say"
- "what's playing" — Clawd puts on headphones to check Spotify
- "pause", "skip", "previous track"
- "play [song or artist name]" — plays the first matching track if you've connected Spotify (see below); otherwise Clawd will ask you to connect

Mundane questions ("what's 2+2") just stream back without any tool use.

### Tray menu

Click `clawd` in the macOS menubar (top-right area, near time/wifi). Options:

- **Reset conversation** — clears Clawd's memory of the current chat
- **Move to monitor →** — list of every connected display; click to instantly move Clawd to that one
- **Launch at login** — checkbox; toggle on to have Clawd start every time you log in to your Mac
- **Quit Clawd**

### Spotify auto-play (optional)

Out of the box, Clawd doesn't have Spotify auto-play wired up. To enable it:

1. Click the **`clawd`** label in your macOS menubar (top-right area).
2. Pick **Connect Spotify…**
3. Your browser opens to a Spotify authorization page. Log in with your Spotify account if needed, click **Agree**.
4. Browser shows "clawd is connected to spotify" — you can close the tab.
5. Done. The menu item flips to **Disconnect Spotify** for whenever you want to revoke.

That's it. No developer dashboard, no API credentials, no editing config files. Clawd uses Spotify's OAuth PKCE flow — only your account is involved, no shared infrastructure.

After connecting, ask Clawd things like "play hello by adele" or "play some daft punk". He searches Spotify and tells your local desktop Spotify to play the first result. The Spotify window stays hidden (won't steal focus while you're working).

### When Clawd sleeps

After about 3 minutes with no chat interaction, Clawd dozes off — eyes closed, no walking. Click him or send a message and he wakes up immediately.

---

## Updating Clawd

When you pull new code or change something locally:

```
git pull
npm run pack
rm -rf /Applications/Clawd.app
cp -R dist/mac-arm64/Clawd.app /Applications/
```

Then right-click → Open the first time (signature changed). If Screen Recording stops working, re-grant per the steps above.

---

## Building for Intel Macs

The `npm run pack` script defaults to whatever architecture you're on. If you need an Intel build, change the `pack` script in `package.json` to:

```
"pack": "electron-builder --mac --x64 --dir"
```

…or build both with `--universal`. Output will land in `dist/mac/Clawd.app` or `dist/mac-x64/Clawd.app`.

---

## What's inside

- **`main.js`** — Electron main process: window, IPC, tray, app-switch watcher.
- **`preload.js`** — secure bridge between renderer and main.
- **`agent.js`** — talks to the Claude Agent SDK using your subscription auth.
- **`tools.js`** — the tools Clawd can call (time, frontmost window, screen capture, window capture, Spotify controls).
- **`renderer/crab.js`** — pure pixel-art crab. The whole sprite is a `string[]` you can edit by hand; animation is procedural, no sprite sheets.
- **`renderer/chat.js`** — the chat panel UI.
- **`build/icon.png`** — generated by `node scripts/generate-icon.js`.

---

## Known limitations

- **macOS only.** AppleScript + desktopCapturer + macOS-specific tray behavior.
- **Not Apple-Developer-ID signed.** First-launch Gatekeeper warning still requires the right-click → Open ritual (only a paid Apple Developer ID `$99 / year` would remove that). The `npm run setup-signing` self-signed cert solves the permission-reset-on-rebuild issue but doesn't satisfy Gatekeeper.
- **One monitor at a time.** Use the tray submenu to switch — cross-monitor traversal was glitchy on macOS so it's gone.
- **Spotify auto-play needs a one-time OAuth login.** No developer setup required — just click "Connect Spotify" in the tray menu and authorize once.
- **Notification reactions are app-switch reactions.** macOS doesn't expose system notifications without private APIs or Full Disk Access against the notification SQLite database. App-switch is the closest analog.

---

## Credits

Built with [Electron](https://www.electronjs.org/), the [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk), and a small grid of orange pixels.
