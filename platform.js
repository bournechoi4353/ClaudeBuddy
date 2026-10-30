// Cross-platform OS primitives.
//
// macOS reaches the system through `osascript` (AppleScript); Windows through
// PowerShell. Everything here degrades to null / empty strings on an
// unsupported platform so callers can no-op gracefully instead of throwing.
//
// Used by main.js (battery + foreground-app polling) and tools.js
// (frontmost_window). The heavier macOS-app integrations (Spotify, Calendar,
// Notes, Mail, browser tabs) stay in their own files behind their own platform
// guards — this module only covers the primitives both files share.

const { spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Spawn a command, collect stdout, reject on non-zero/timeout. windowsHide keeps
// PowerShell from flashing a console window on every poll.
function run(cmd, args, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `${cmd} exit ${code}`));
    });
    proc.on('error', (e) => {
      clearTimeout(killer);
      reject(e);
    });
  });
}

function osascript(script) {
  return run('osascript', ['-e', script]).then((s) => s.trim());
}

// Pass PowerShell scripts as a UTF-16LE base64 -EncodedCommand so we never have
// to fight cmd/PowerShell quoting rules for multi-line P/Invoke scripts.
function powershell(script) {
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64]).then((s) => s.trim());
}

// Windows process names ("chrome", "Code", "msedge") differ from the macOS app
// names the idle-chatter / reaction lines key off of ("Google Chrome", ...).
// Map the common ones back so behavior matches across platforms; anything
// unknown just gets its first letter capitalized.
const WIN_APP_NAMES = {
  chrome: 'Google Chrome',
  msedge: 'Microsoft Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  arc: 'Arc',
  code: 'Visual Studio Code',
  cursor: 'Cursor',
  slack: 'Slack',
  discord: 'Discord',
  spotify: 'Spotify',
  figma: 'Figma',
  windowsterminal: 'Terminal',
  wt: 'Terminal',
  powershell: 'Terminal',
  cmd: 'Terminal',
  notion: 'Notion',
  linear: 'Linear',
  outlook: 'Mail',
  olk: 'Mail',
  zoom: 'zoom.us',
  explorer: 'Finder',
};

function normalizeWinApp(name) {
  if (!name) return '';
  const key = name.toLowerCase();
  if (WIN_APP_NAMES[key]) return WIN_APP_NAMES[key];
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// PowerShell that returns "<processName>::<windowTitle>" for whatever window is
// in the foreground. Add-Type compiles a tiny P/Invoke shim each call.
const WIN_FOREGROUND_PS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
}
"@
$h = [FgWin]::GetForegroundWindow()
[uint32]$procId = 0
[void][FgWin]::GetWindowThreadProcessId($h, [ref]$procId)
$proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
$name = if ($proc) { $proc.ProcessName } else { "" }
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowText($h, $sb, 512)
[Console]::Out.Write($name + "::" + $sb.ToString())
`;

async function frontmostWin() {
  try {
    const out = await powershell(WIN_FOREGROUND_PS);
    const idx = out.indexOf('::');
    const rawApp = idx > -1 ? out.slice(0, idx) : out;
    const title = idx > -1 ? out.slice(idx + 2) : '';
    return { app: normalizeWinApp(rawApp.trim()), title: title.trim() };
  } catch (_) {
    return { app: '', title: '' };
  }
}

// macOS frontmost: app name + front window title (window title needs the same
// Accessibility permission AppleScript already relies on; falls back to "").
const MAC_FOREGROUND_OSA = `tell application "System Events"
set frontApp to name of first application process whose frontmost is true
try
tell process frontApp
set frontWindow to name of front window
end tell
on error
set frontWindow to ""
end try
return frontApp & "::" & frontWindow
end tell`;

// Returns just the foreground application's display name (or '' if unknown).
async function getFrontmostApp() {
  if (IS_MAC) {
    try {
      return (await osascript('tell application "System Events" to return name of first application process whose frontmost is true')).trim();
    } catch (_) {
      return '';
    }
  }
  if (IS_WIN) return (await frontmostWin()).app;
  return '';
}

// Returns { app, title } for the foreground window.
async function getFrontmostWindow() {
  if (IS_MAC) {
    try {
      const out = await osascript(MAC_FOREGROUND_OSA);
      const idx = out.indexOf('::');
      return {
        app: idx > -1 ? out.slice(0, idx) : out,
        title: idx > -1 ? out.slice(idx + 2) : '',
      };
    } catch (err) {
      return { app: '', title: '', error: err.message || String(err) };
    }
  }
  if (IS_WIN) return frontmostWin();
  return { app: '', title: '' };
}

// PowerShell battery query: "<percent>|<batteryStatus>". BatteryStatus 1 means
// discharging; anything else means it's on AC / charging / full.
const WIN_BATTERY_PS = `
$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($b) { [Console]::Out.Write([string]$b.EstimatedChargeRemaining + "|" + [string]$b.BatteryStatus) }
`;

// Returns { percent, charging } or null if there's no battery / it can't be read
// (e.g. a desktop PC). Callers should treat null as "skip battery checks".
async function getBattery() {
  if (IS_MAC) {
    try {
      const out = await run('pmset', ['-g', 'batt']);
      const m = out.match(/(\d+)%;\s*([a-zA-Z ]+?);/);
      if (!m) return null;
      return { percent: parseInt(m[1], 10), charging: m[2].toLowerCase().trim() !== 'discharging' };
    } catch (_) {
      return null;
    }
  }
  if (IS_WIN) {
    try {
      const out = (await powershell(WIN_BATTERY_PS)).trim();
      if (!out) return null;
      const [pctStr, statusStr] = out.split('|');
      const percent = parseInt(pctStr, 10);
      if (!Number.isFinite(percent)) return null;
      return { percent, charging: parseInt(statusStr, 10) !== 1 };
    } catch (_) {
      return null;
    }
  }
  return null;
}

// macOS: is the frontmost app's front window in native full screen? Reading the
// AXFullScreen attribute needs the same Accessibility permission as the window
// title lookup above; without it this reports false.
const MAC_FULLSCREEN_OSA = `tell application "System Events"
set frontProc to first application process whose frontmost is true
try
return (value of attribute "AXFullScreen" of front window of frontProc) as text
on error
return "false"
end try
end tell`;

// Windows: SHQueryUserNotificationState reports 2 (busy, a full-screen app),
// 3 (Direct3D full screen) or 4 (presentation mode) when the user should not be
// interrupted. UNTESTED on Windows.
const WIN_FULLSCREEN_PS = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class UserNotifState {
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
}
"@
$state = 0
[void][UserNotifState]::SHQueryUserNotificationState([ref]$state)
[Console]::Out.Write([string]$state)
`;

// True when a full-screen app or a presentation is in front. Any failure means false.
async function isFrontmostFullscreen() {
  try {
    if (IS_MAC) return (await osascript(MAC_FULLSCREEN_OSA)).trim() === 'true';
    if (IS_WIN) return ['2', '3', '4'].includes((await powershell(WIN_FULLSCREEN_PS)).trim());
  } catch (_) {}
  return false;
}

// Spotify playback state as 'playing', 'paused' or 'none'. macOS only, and it only
// talks to Spotify when the app is already running, so it never launches it. On
// Windows this reports 'none' (the Web API route would be a network call).
async function getMusicState() {
  if (!IS_MAC) return 'none';
  try {
    const count = await osascript('tell application "System Events" to count (every process whose name is "Spotify")');
    if (!(parseInt(count, 10) > 0)) return 'none';
    const state = await osascript('tell application "Spotify" to get player state as text');
    if (state === 'playing') return 'playing';
    if (state === 'paused') return 'paused';
  } catch (_) {}
  return 'none';
}

module.exports = {
  IS_MAC,
  IS_WIN,
  getFrontmostApp,
  getFrontmostWindow,
  getBattery,
  isFrontmostFullscreen,
  getMusicState,
};
