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

### 3. Build the app

```
npm run pack
```

This produces `dist/mac-arm64/Clawd.app`. Takes about a minute.

### 4. Move Clawd into Applications

```
cp -R dist/mac-arm64/Clawd.app /Applications/
```

### 5. First launch (one-time Gatekeeper step)

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

> **Note:** Because Clawd is ad-hoc signed, the permission may need to be re-granted every time you rebuild. If after a rebuild Clawd says he can't see your screen, repeat the steps above.

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
- "play [song or artist name]" — plays the first matching track if you've set up Spotify API credentials (see below); otherwise opens the search page

Mundane questions ("what's 2+2") just stream back without any tool use.

### Tray menu

Click `clawd` in the macOS menubar (top-right area, near time/wifi). Options:

- **Reset conversation** — clears Clawd's memory of the current chat
- **Move to monitor →** — list of every connected display; click to instantly move Clawd to that one
- **Launch at login** — checkbox; toggle on to have Clawd start every time you log in to your Mac
- **Quit Clawd**

### Spotify auto-play setup (optional)

Out of the box, "play \<song\>" opens Spotify's search page and you click to play. To make Clawd actually play the first result automatically:

1. Go to <https://developer.spotify.com/dashboard>, log in with your Spotify account, click **Create app**.
2. Fill in the form:
   - **App name / description:** anything.
   - **Redirect URI:** `http://127.0.0.1:8888/callback` — type it into the field then **click the Add button next to the field** so it appears as a chip below. (Spotify rejects the form if you don't actually click Add. We never use this URL — it's just required by the form.)
   - **Which API/SDKs:** check **Web API** only.
   - Agree to the terms, click **Save**.
3. On the app's dashboard page, copy the **Client ID**. Click **View client secret** to reveal the secret and copy that too.
4. Open Clawd's prefs file in TextEdit:
   ```
   open -e ~/Library/Application\ Support/Clawd/prefs.json
   ```
   Add the two keys (keep any existing keys like `scale`):
   ```json
   {
     "scale": 6,
     "spotifyClientId": "your_client_id",
     "spotifyClientSecret": "your_client_secret"
   }
   ```
   Save with ⌘+S.
5. **No relaunch needed.** Clawd re-reads the prefs file every 5 seconds. Ask "play hello by adele" and it should play immediately.

The credentials only let Clawd search Spotify's public catalog via the client-credentials flow — they don't access your account, playlists, or playback history. Actual playback is still triggered through the local Spotify desktop app via AppleScript using the track URI returned by the search.

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
- **Ad-hoc signed.** Every rebuild gets a new code-signing hash, so macOS may forget Screen Recording permission across rebuilds. A proper Developer ID signature (`$99 / year` Apple Developer Program) would fix this.
- **One monitor at a time.** Use the tray submenu to switch — cross-monitor traversal was glitchy on macOS so it's gone.
- **Spotify auto-play needs API credentials.** Free but requires creating a Spotify developer app (see setup above). Without it, "play \<song\>" falls back to opening the search page.
- **Notification reactions are app-switch reactions.** macOS doesn't expose system notifications without private APIs or Full Disk Access against the notification SQLite database. App-switch is the closest analog.

---

## Credits

Built with [Electron](https://www.electronjs.org/), the [Claude Agent SDK](https://docs.claude.com/en/docs/claude-code/sdk), and a small grid of orange pixels.
