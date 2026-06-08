# Clawd

A pixel-art crab pet that lives on your macOS **or Windows** desktop and is also Claude. Click him to chat. He can look at your screen, control Spotify, react when you switch apps, take naps when ignored, and walk around the bottom of whichever monitor you pick.

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

### Install on Windows

The curl one-liner above is macOS-only. On Windows, open **PowerShell** and paste:

```powershell
irm https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.ps1 | iex
```

That's it. The installer:
- installs Node.js for you (via winget) if it's missing
- downloads the source
- builds Clawd locally
- installs it to `%LOCALAPPDATA%\Clawd-src` and adds Start Menu + Desktop shortcuts
- launches it

It builds under `%LOCALAPPDATA%` (keeping `node_modules` out of OneDrive's cloud sync) and self-repairs Electron's binary if its download cache is broken — a common Windows snag that otherwise leaves the app unable to start. Re-run the same line anytime to update.

You'll still need Claude Code installed and signed in for chat (see "Set up Claude" below) — on Windows run `claude login` in PowerShell. The build is unsigned, so SmartScreen may warn on first launch: click **More info → Run anyway**.

Prefer to build by hand? See "For developers" at the bottom.

### First launch

macOS will block the first launch because Clawd isn't signed by an Apple Developer account. **One-time workaround:**

1. Open Finder → Applications
2. **Right-click `Clawd` → Open** (don't double-click)
3. Click **Open** in the Gatekeeper warning

After that, Clawd is trusted — Spotlight, Launchpad, double-click all work normally.

---

## Requirements

- **macOS on Apple Silicon** (M1 / M2 / M3 / M4) — well tested. Intel Macs should work too (the installer auto-detects arch and builds the right binary) but they're not tested yet.
- **Windows 10 / 11** (x64 or ARM64) — supported via the one-line PowerShell installer (see "Install on Windows"). Some macOS-app integrations degrade gracefully there; see "Known limitations".
- **Node.js 20+** — used to build Clawd. Install with `brew install node` (macOS) or from <https://nodejs.org> (any OS).
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

Run the installer again — it pulls the latest source and rebuilds.

macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.ps1 | iex
```

After updating on macOS, right-click → Open the first time because the signature changed.

## Uninstalling Clawd

macOS:

```bash
pkill -f Clawd.app 2>/dev/null
rm -rf /Applications/Clawd.app
rm -rf "$HOME/Library/Application Support/Clawd"
rm -rf "$HOME/Library/Application Support/Clawd-src"
tccutil reset ScreenCapture dev.clawd.app 2>/dev/null
osascript -e 'tell application "System Events" to delete login item "Clawd"' 2>/dev/null
```

Windows: open **Settings → Apps → Installed apps**, find **Clawd**, and click **Uninstall**.

Or by hand in PowerShell:

```powershell
$src = "$env:LOCALAPPDATA\Clawd-src"
# Clawd runs as electron.exe out of $src - stop it by path so other Electron apps are untouched
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($src) } | Stop-Process -Force
Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Clawd" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Clawd.lnk" -ErrorAction SilentlyContinue
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\Clawd.lnk" -ErrorAction SilentlyContinue
```


---

## For developers

Want to hack on Clawd? Clone manually and use the npm scripts:

```bash
git clone https://github.com/bournechoi4353/ClaudeBuddy.git
cd ClaudeBuddy
npm install
npm run setup-signing   # macOS only — sets up the self-signed cert
npm start               # dev mode (Electron with hot file load)
npm run pack            # build Clawd.app into dist/mac-arm64/
npm run dist:win        # build a Windows NSIS installer into dist/ (run on Windows)
```

Note: `npm install` only fetches the Claude Agent SDK native binary for the OS you run it on. To build a Windows installer you must run on Windows (or otherwise install `@anthropic-ai/claude-agent-sdk-win32-x64`). Same for building the Mac app on macOS.

Project structure:

- `main.js` — Electron main process: windows, tray, IPC, app-switch watcher.
- `preload.js` — secure bridge between renderer and main.
- `agent.js` — wraps the Claude Agent SDK with subscription auth.
- `tools.js` — tools Clawd can call (time, frontmost window, screen/window capture, Spotify).
- `platform.js` — cross-platform OS primitives (foreground app + battery: AppleScript on macOS, PowerShell on Windows).
- `spotify-auth.js` — OAuth Authorization Code + PKCE flow for Spotify connection.
- `renderer/crab.js` — the pixel-art crab, animation state machine, accessories.
- `renderer/chat.js` — chat panel UI.
- `scripts/generate-icon.js` — pure-JS PNG encoder that renders the crab into `build/icon.png`.
- `scripts/setup-self-signed.sh` — creates and trusts the self-signed code-signing cert.

See [CLAUDE.md](CLAUDE.md) for architectural notes useful when editing the codebase.
