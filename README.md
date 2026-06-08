
https://github.com/user-attachments/assets/b6603a68-3ae0-4098-bf8c-6c0ec1cbfa7f


# Clawd

Clawd is a little pixel crab who lives on your desktop, and he's also Claude. Click him and a tiny chat window pops up over his head. He can look at your screen, control Spotify, hop around when you switch apps, doze off when you ignore him, and wander along the bottom of whichever monitor you put him on.

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

That's the whole thing. The installer will:

- install Node.js for you (using winget) if you don't have it
- download the source
- build Clawd on your machine
- drop it in `%LOCALAPPDATA%\Clawd-src` with Start Menu and Desktop shortcuts
- launch it

It builds under `%LOCALAPPDATA%` so your `node_modules` stay out of OneDrive's cloud sync, and it fixes Electron's download cache automatically if it's broken (a common Windows snag that otherwise stops the app from starting). Run the same line again any time you want to update.

You'll also need Claude Code installed and signed in for the chat to work (see "Set up Claude" below). On Windows you run `claude login` in PowerShell. Since the build isn't signed, **Windows SmartScreen may warn you on first launch**, just click **More info** then **Run anyway**.

## Build from source on Mac (one liner)

Want the source build instead of the `.dmg`? Open Terminal and paste:

```bash
curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
```

It checks your machine, pulls the source, builds Clawd, signs it with a local certificate, and installs it to `/Applications`. First build takes a couple of minutes, reinstalls take about thirty seconds. Same first launch step applies: right click Clawd and choose Open.

## What you need

- A **Mac on Apple Silicon** (M1, M2, M3, M4). Intel Macs should work too if you build from source, they just aren't tested yet.
- Or **Windows 10 or 11** (x64 or ARM64), installed with the PowerShell line above. A few Mac only features fall back gracefully on Windows, see "What's different on Windows" near the bottom.
- **A Claude Pro or Max subscription.**
- **Claude Code installed and signed in.** Grab it from [claude.com/code](https://claude.com/code) and run `claude login`. Clawd can walk around without this, but he can't chat until you do it.
- **Node.js 20 or newer**, only if you're building from source. `brew install node` on Mac, or [nodejs.org](https://nodejs.org) anywhere.
- **Spotify desktop app**, optional, only if you want Clawd to play music.

## Set up Claude (one time)

Clawd uses your subscription instead of an API key, so there's nothing to paste into a config file. You just need Claude Code logged in:

1. Install Claude Code from [claude.com/code](https://claude.com/code).
2. Open a terminal and run:

   ```bash
   claude login
   ```

3. Sign in with your Claude Pro or Max account.

That's it. Clawd reads the login that Claude Code saves to `~/.claude/.credentials.json` and starts chatting.

## Connect Spotify (optional)

1. Click the **`clawd`** label in your Mac menu bar, up near the clock.
2. Pick **Connect Spotify**.
3. Your browser opens Spotify's sign in page. Log in and click **Agree**.
4. When the page says "clawd is connected to spotify", close the tab.

Now you can say things like "play hello by adele" and it just plays. Premium accounts get a clean experience through the Spotify Web API, and Free accounts fall back to controlling the desktop app directly. To unhook it later, the same menu item turns into **Disconnect Spotify**. Clawd never sees your password, it's a normal OAuth login and the token stays on your own machine.

## Granting Screen Recording

The first time Clawd peeks at your screen (the "what's on my screen" type questions), macOS asks for permission.

1. Click Clawd and ask "what's on my screen?"
2. Click **Open System Settings** when the prompt shows up.
3. Turn **Clawd** on under Privacy & Security, then Screen Recording.
4. **Quit Clawd from the menu bar** (`clawd`, then Quit Clawd) and open him again. macOS only applies the new permission after a full restart of the app.

Because the build uses a stable certificate, you only grant this once. It sticks around through future updates.

## Using Clawd

Clawd strolls back and forth along the bottom of one monitor. He mixes up a few moods, walking, pausing, stretching, the odd quick scuttle, and he hops when you switch apps.

### Chatting

Click on Clawd and a small chat box opens above him. Type, press Enter. Press Esc or click away to close it.

### Things you can ask

- "what time is it"
- "what app am i in"
- "what's on my screen" (Clawd puts on reading glasses while he looks)
- "read my chrome tab" or "look at slack"
- "what's playing" (Clawd puts on headphones to check Spotify)
- "pause", "skip", "previous track"
- "play [a song or artist]" (plays the first match once you've connected Spotify)

Everyday questions like "what's 2 plus 2" just stream back with no tools at all.

### Tray menu

Click `clawd` in the Mac menu bar for these:

- **Reset conversation**, wipes what Clawd remembers from the current chat
- **Size**, small, medium, large, or huge
- **Move to monitor**, pick which display he lives on
- **Connect Spotify** / **Disconnect Spotify**
- **Launch at login**, a checkbox to start Clawd whenever you log in
- **Quit Clawd**

### When Clawd sleeps

After about three minutes with no chatting, Clawd nods off. His eyes close, he stops walking, and little `z`s float up from his head. Click him or send a message and he wakes up right away.

## Updating Clawd

If you installed the `.dmg`, just download the newest one from the [Releases page](https://github.com/bournechoi4353/ClaudeBuddy/releases) and drag it over the old one. Right click and Open the first time, since the new build's signature changed.

If you used a one line installer, run it again to pull the latest source and rebuild.

Mac:

```bash
curl -fsSL https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.sh | bash
```

Windows:

```powershell
irm https://raw.githubusercontent.com/bournechoi4353/ClaudeBuddy/main/install.ps1 | iex
```

## Uninstalling Clawd

Mac:

```bash
pkill -f Clawd.app 2>/dev/null
rm -rf /Applications/Clawd.app
rm -rf "$HOME/Library/Application Support/Clawd"
rm -rf "$HOME/Library/Application Support/Clawd-src"
tccutil reset ScreenCapture dev.clawd.app 2>/dev/null
osascript -e 'tell application "System Events" to delete login item "Clawd"' 2>/dev/null
```

Windows: open **Settings**, then **Apps**, then **Installed apps**, find **Clawd**, and click **Uninstall**.

Or by hand in PowerShell:

```powershell
$src = "$env:LOCALAPPDATA\Clawd-src"
# Clawd runs as electron.exe out of $src, so stop it by path and leave other Electron apps alone
Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($src) } | Stop-Process -Force
Remove-Item $src -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Clawd" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Clawd.lnk" -ErrorAction SilentlyContinue
Remove-Item "$([Environment]::GetFolderPath('Desktop'))\Clawd.lnk" -ErrorAction SilentlyContinue
```

## What's different on Windows

Most of Clawd works the same on both systems: chatting, web search, weather, timers, clipboard, screen and window capture, app switch reactions, battery warnings, Gmail and Google Drive and Docs, and Spotify.

A handful of features lean on Apple specific scripting, so on Windows they politely tell you they're Mac only instead of breaking: Apple Calendar, Apple Notes, Apple Mail, and reading a browser tab directly. On Windows you can connect Google for email, and ask Clawd to "search the web" or "look at my screen" for the rest. Spotify on Windows runs through the Spotify Web API, which needs Premium and the desktop app open once so it shows up as a device.

## For developers

Want to poke at the code? Clone it and use the npm scripts:

```bash
git clone https://github.com/bournechoi4353/ClaudeBuddy.git
cd ClaudeBuddy
npm install
npm run setup-signing   # Mac only, sets up the self signed cert
npm start               # dev mode with hot file loading
npm run pack            # build Clawd.app into dist/mac-arm64/
npm run dist            # build the .dmg into dist/
npm run dist:win        # build a Windows installer into dist/ (run this on Windows)
```

One thing to know: `npm install` only grabs the Claude Agent SDK native binary for the system you run it on. So to build the Windows installer you have to be on Windows (or install `@anthropic-ai/claude-agent-sdk-win32-x64` yourself), and the Mac build has to happen on a Mac.

How the project is laid out:

- `main.js`, the Electron main process: windows, tray, IPC, the app switch watcher.
- `preload.js`, the secure bridge between the renderer and main.
- `agent.js`, wraps the Claude Agent SDK and handles subscription auth.
- `tools.js`, the tools Clawd can call (time, foreground window, screen capture, Spotify, and more).
- `platform.js`, small cross platform helpers (foreground app and battery: AppleScript on Mac, PowerShell on Windows).
- `spotify-auth.js`, the OAuth with PKCE flow for connecting Spotify.
- `renderer/crab.js`, the pixel crab itself: drawing, animation, accessories.
- `renderer/chat.js`, the chat panel.
- `scripts/generate-icon.js`, a pure JS PNG encoder that draws the crab into `build/icon.png`.
- `scripts/setup-self-signed.sh`, creates and trusts the self signed signing cert.

For deeper notes on how everything fits together, see [CLAUDE.md](CLAUDE.md).
