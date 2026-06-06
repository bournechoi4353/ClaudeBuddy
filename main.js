const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Tiny prefs file so user choices survive relaunches.
const PREFS_PATH = path.join(app.getPath('userData'), 'prefs.json');
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
  try {
    fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
    fs.writeFileSync(PREFS_PATH, JSON.stringify(p));
  } catch (_) {}
}
const SIZES = [
  { label: 'Small',  scale: 4 },
  { label: 'Medium', scale: 6 },
  { label: 'Large',  scale: 9 },
  { label: 'Huge',   scale: 14 },
];
const DEFAULT_SCALE = 6;
let prefs = loadPrefs();
function currentScale() {
  return typeof prefs.scale === 'number' ? prefs.scale : DEFAULT_SCALE;
}

// Force subscription auth: ignore any inherited API key so credits come from Claude Pro/Max.
delete process.env.ANTHROPIC_API_KEY;
// Strip parent Claude Code session vars so the SDK starts clean rather than thinking it's nested.
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'AI_AGENT') {
    delete process.env[k];
  }
}

const agent = require('./agent');
const spotifyAuth = require('./spotify-auth');
const googleAuth = require('./google-auth');
const tools = require('./tools');
const platform = require('./platform');
const { dialog, shell } = require('electron');
const os = require('os');

// When a timer ends, the renderer hops Clawd + shows a thought bubble.
tools.setTimerEndCallback(({ id, label }) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('clawd-timer-ended', { id, label });
  }
});

// ---- Proactive monitor ----
// Polls every 60s for ambient events that warrant a small unprompted reaction
// from Clawd: low battery, calendar events starting in ~5 min. Each alert is
// de-duplicated so the same event never fires twice.
const notifiedBatteryThresholds = new Set();
const notifiedCalendarEventIds = new Set();

let lastNotifyAt = 0;
function sendNotify(text, durationMs) {
  if (!mainWin || mainWin.isDestroyed()) return;
  lastNotifyAt = Date.now();
  mainWin.webContents.send('clawd-notify', { text, durationMs: durationMs || 15000 });
}

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(out));
    p.on('error', () => resolve(''));
  });
}

async function checkBattery() {
  // platform.getBattery() abstracts pmset (mac) / Win32_Battery (windows) and
  // returns null on a machine with no readable battery (e.g. a desktop PC).
  const batt = await platform.getBattery();
  if (!batt) return;
  const pct = batt.percent;
  // Reset alerts whenever we're charging / on AC (plug-in cancels low-battery warnings).
  if (batt.charging) {
    notifiedBatteryThresholds.clear();
    return;
  }
  // Re-arm higher thresholds if charge climbed back above them (e.g. brief plug-in).
  if (pct > 25) notifiedBatteryThresholds.clear();
  const thresholds = [
    { at: 20, text: 'battery at 20%. charger soon would be nice.' },
    { at: 10, text: 'battery at 10%! plug me in.' },
    { at: 5,  text: 'battery at 5%!! plug in now!' },
  ];
  for (const t of thresholds) {
    if (pct <= t.at && !notifiedBatteryThresholds.has(t.at)) {
      notifiedBatteryThresholds.add(t.at);
      sendNotify(t.text, 20000);
      return;
    }
  }
}

async function isCalendarRunning() {
  try {
    const out = await runCmd('osascript', ['-e', 'tell application "System Events" to count (every process whose name is "Calendar")']);
    return parseInt(out.trim(), 10) > 0;
  } catch {
    return false;
  }
}

async function checkCalendarSoon() {
  // Calendar.app + AppleScript is macOS-only; on Windows there's no equivalent
  // local calendar to poll, so the proactive "event starts in 5 min" nudge is
  // simply skipped (battery alerts and idle chatter still run).
  if (!platform.IS_MAC) return;
  // Only poll Calendar.app if the user already has it running — never auto-launch
  // it on the user's behalf, that would be intrusive.
  if (!(await isCalendarRunning())) return;
  // Events starting in the next 6 minutes (so the first 60s tick after the
  // 5-min mark is crossed will fire one alert per event, and only once).
  const script = `set output to ""
tell application "Calendar"
set startDate to current date
set endDate to startDate + 360
repeat with cal in calendars
try
set evs to (every event of cal whose start date is greater than or equal to startDate and start date is less than or equal to endDate)
repeat with ev in evs
set output to output & (uid of ev) & "|||" & (summary of ev as text) & linefeed
end repeat
end try
end repeat
end tell
return output`;
  const out = await runCmd('osascript', ['-e', script]);
  if (!out.trim()) return;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const idx = line.indexOf('|||');
    if (idx < 0) continue;
    const uid = line.slice(0, idx);
    const title = line.slice(idx + 3);
    if (!uid || notifiedCalendarEventIds.has(uid)) continue;
    notifiedCalendarEventIds.add(uid);
    sendNotify(`"${title}" starts in 5 min`, 25000);
  }
  // Keep the de-dup set bounded — events past will never come back through
  // the 6-minute window, so a periodic clear is safe.
  if (notifiedCalendarEventIds.size > 500) notifiedCalendarEventIds.clear();
}

let proactiveTimer = null;
function startProactiveMonitor() {
  if (proactiveTimer) return;
  const tick = async () => {
    try { await checkBattery(); } catch (_) {}
    try { await checkCalendarSoon(); } catch (_) {}
  };
  // First tick after 10s so the renderer is mounted, then every 60s.
  setTimeout(tick, 10_000);
  proactiveTimer = setInterval(tick, 60_000);
}

// ---- Idle chatter ----
// Every 25-45 minutes Clawd bubbles a tiny unprompted thought, weighted by
// the user's frontmost app and the time of day. Skipped if another notification
// fired in the last few minutes (so chatter never piles on top of timer/battery
// alerts) and if we're still inside the post-launch quiet window.

const APP_LINES = {
  'Code': ['writing something good?', 'all those brackets...', 'i like the syntax colors'],
  'Visual Studio Code': ['writing something good?', 'all those brackets...', 'i like the syntax colors'],
  'Cursor': ['the cursor flows', 'tab tab tab', 'writing something good?'],
  'Google Chrome': ['what are you reading?', '...so many tabs', 'is the internet on?'],
  'Safari': ['safari kinda vibes', 'what are you reading?', '...nice page'],
  'Arc': ['arc is fancy', 'what are you reading?'],
  'Firefox': ['the firefox is foxy'],
  'Slack': ['the messages, they multiply', 'good luck in there', 'is it that meeting again'],
  'Discord': ['discord. the chatty one.'],
  'Spotify': ['this is a good one', 'turn it up?', '...nice tune'],
  'Figma': ['the colors...', 'i like the layers', 'pixel perfect huh'],
  'Terminal': ['green on black. classic.', '...that prompt looks crisp'],
  'iTerm2': ['green on black. classic.', '...that prompt looks crisp'],
  'Notion': ['so much organization', 'lots of pages'],
  'Linear': ['the tickets, they accumulate'],
  'Mail': ['inbox zero is a myth'],
  'zoom.us': ['meeting again?', 'unmute. always unmute.'],
  'Calendar': ['what is on the schedule'],
  'Finder': ['so many folders', '...where did it go'],
  'Xcode': ['the build is building', 'fingers crossed'],
};

const TIME_LINES = {
  morning:   ['it is quiet in the morning', 'tea time?', 'the light is nice this hour'],
  midday:    ['is it lunch yet', '...stretch break?', 'almost noon'],
  afternoon: ['the afternoon slump is real', '...iced something?', 'still going strong'],
  evening:   ['the sky looks orange', 'what is for dinner', 'winding down'],
  night:     ['it is getting late', 'the city is quieter at night', '...'],
  late:      ['still up?', 'i am getting sleepy', 'rest soon ok'],
};

const GENERAL_LINES = [
  '...just thinking', 'the floor feels nice today', 'tiny gust earlier',
  'i wonder if other crabs have wifi', '...hmm', 'a small thought, nothing big',
  'the cursor is so blinky', 'the menubar is full', 'i napped a little',
  '...is there sand somewhere', 'small claws, big plans',
];

function timeBucket(d) {
  const h = d.getHours();
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 12) return 'midday';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 21) return 'evening';
  if (h >= 21 || h < 1) return 'night';
  return 'late';
}

function pickIdleThought(frontApp) {
  const pool = [];
  if (frontApp && APP_LINES[frontApp]) pool.push(...APP_LINES[frontApp], ...APP_LINES[frontApp]);
  pool.push(...TIME_LINES[timeBucket(new Date())]);
  pool.push(...GENERAL_LINES);
  return pool[Math.floor(Math.random() * pool.length)];
}

function startIdleChatter() {
  const queueNext = () => {
    const min = 25 * 60 * 1000;
    const max = 45 * 60 * 1000;
    const delay = min + Math.floor(Math.random() * (max - min));
    setTimeout(async () => {
      // Don't pile on top of a recent battery / calendar / timer bubble.
      if (Date.now() - lastNotifyAt < 4 * 60 * 1000) {
        queueNext();
        return;
      }
      let front = '';
      try {
        front = await platform.getFrontmostApp();
      } catch (_) {}
      sendNotify(pickIdleThought(front), 10000);
      queueNext();
    }, delay);
  };
  // Quiet for the first 8 minutes after launch so we don't ambush users.
  setTimeout(queueNext, 8 * 60 * 1000);
}

function maybeShowClaudeOnboarding() {
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (fs.existsSync(credsPath)) return;
  const termName = platform.IS_WIN ? 'PowerShell (or Command Prompt)' : 'Terminal';
  const result = dialog.showMessageBoxSync({
    type: 'info',
    title: 'Welcome to Clawd',
    message: 'Set up Claude',
    detail:
      "Clawd talks using your Claude Pro/Max subscription — there's no API key to add.\n\n" +
      "If you don't have Claude Code installed yet:\n" +
      "   1. Install it from https://claude.com/code\n" +
      `   2. Open ${termName} and run:  claude login\n` +
      "   3. Sign in with your Claude account\n" +
      "   4. Quit and relaunch Clawd\n\n" +
      "Clawd will appear and walk around regardless, but he can't chat until this is done.",
    buttons: ['Open claude.com/code', 'OK, I will do it later'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result === 0) shell.openExternal('https://claude.com/code');
}

let mainWin = null;
let currentDisplayId = null;

function createMainWindow(display) {
  const wa = display.workArea;
  currentDisplayId = display.id;

  mainWin = new BrowserWindow({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWin.setIgnoreMouseEvents(true, { forward: true });
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    search: `scale=${currentScale()}`,
  });

  startAppSwitchWatcher(mainWin);
}

function moveToDisplay(display) {
  if (!mainWin || mainWin.isDestroyed()) return;
  currentDisplayId = display.id;
  const wa = display.workArea;
  mainWin.setBounds({
    x: wa.x,
    y: wa.y,
    width: wa.width,
    height: wa.height,
  });
  rebuildTrayMenu();
}

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

// Right-clicking the crab pops up the tray menu at the cursor. On Windows the
// tray icon lives in the hidden-icons overflow, so this is the main way to open
// settings without hunting for it; on macOS it's a shortcut. Mac behavior is
// otherwise unchanged.
ipcMain.on('open-menu', () => {
  if (!mainWin || mainWin.isDestroyed()) return;
  Menu.buildFromTemplate(buildTrayMenuTemplate()).popup({ window: mainWin });
});

ipcMain.on('chat-send', async (event, text) => {
  // First-launch naming ceremony — the very first chat message is interpreted
  // as the pet's new name, not as a question for the agent. Validates to
  // lowercase alphanumeric/_/- only, 1-20 chars, falls back to "clawd".
  if (!prefs.hasOnboarded) {
    let name = (text || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    if (!name) name = 'clawd';
    prefs.petName = name;
    prefs.hasOnboarded = true;
    savePrefs(prefs);
    if (!event.sender.isDestroyed()) {
      // Push the new petName into renderer prefs so the crab UI updates.
      event.sender.send('prefs-updated', { petName: name });
      event.sender.send('chat-piece', { type: 'chunk', text: `${name}. nice name. ask me anything.` });
      event.sender.send('chat-piece', { type: 'done' });
    }
    return;
  }
  try {
    for await (const piece of agent.chat(text)) {
      if (event.sender.isDestroyed()) break;
      event.sender.send('chat-piece', piece);
    }
  } catch (err) {
    if (!event.sender.isDestroyed()) {
      event.sender.send('chat-piece', { type: 'error', error: err.message || String(err) });
      event.sender.send('chat-piece', { type: 'done' });
    }
  }
});

ipcMain.on('chat-reset', () => agent.reset());

// Preferences window IPC.
ipcMain.handle('prefs:get', () => ({ ...prefs }));
ipcMain.on('prefs:set', (_e, updates) => {
  Object.assign(prefs, updates || {});
  savePrefs(prefs);
  // Broadcast live updates to the main crab window so visual prefs
  // (speed, color, sleep threshold) apply immediately.
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('prefs-updated', updates || {});
  }
});

let prefsWin = null;
function openPreferencesWindow() {
  if (prefsWin && !prefsWin.isDestroyed()) {
    prefsWin.focus();
    return;
  }
  prefsWin = new BrowserWindow({
    width: 400,
    height: 540,
    title: 'Clawd Preferences',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#f5f0e6',
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  prefsWin.setMenu(null);
  prefsWin.loadFile(path.join(__dirname, 'renderer', 'preferences.html'));
  prefsWin.on('closed', () => { prefsWin = null; });
}

function startAppSwitchWatcher(win) {
  let lastFront = null;
  let lastReactionAt = 0;
  const REACTION_MIN_GAP_MS = 20_000; // don't spam the user when they alt-tab a lot
  // PowerShell spawns are heavier than osascript, so poll a little less often on
  // Windows to keep CPU down.
  const pollMs = platform.IS_WIN ? 4000 : 2000;
  setInterval(async () => {
    try {
      const front = await platform.getFrontmostApp();
      const now = Date.now();
      if (
        lastFront !== null &&
        front &&
        front !== lastFront &&
        now - lastReactionAt > REACTION_MIN_GAP_MS &&
        !win.isDestroyed()
      ) {
        win.webContents.send('clawd-react', { type: 'app-switch', app: front });
        lastReactionAt = now;
      }
      lastFront = front;
    } catch (_) {
      // ignore — Clawd just won't react this tick
    }
  }, pollMs);
}

let tray = null;

function buildMonitorSubmenu() {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return displays.map((d, idx) => {
    const sizeTag = `${d.bounds.width}×${d.bounds.height}`;
    const primaryTag = d.id === primaryId ? ' — primary' : '';
    const base = d.label && d.label.length ? d.label : `Monitor ${idx + 1}`;
    return {
      label: `${base} (${sizeTag})${primaryTag}`,
      type: 'radio',
      checked: d.id === currentDisplayId,
      click: () => moveToDisplay(d),
    };
  });
}

function buildSizeSubmenu() {
  const cur = currentScale();
  return SIZES.map(({ label, scale }) => ({
    label,
    type: 'radio',
    checked: scale === cur,
    click: () => setScale(scale),
  }));
}

function setScale(scale) {
  prefs.scale = scale;
  savePrefs(prefs);
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('clawd-set-scale', { scale });
  }
  rebuildTrayMenu();
}

let spotifyConnecting = false;

async function connectSpotify() {
  if (spotifyConnecting) return;
  spotifyConnecting = true;
  rebuildTrayMenu();
  try {
    const tokens = await spotifyAuth.connect();
    prefs.spotifyRefreshToken = tokens.refresh_token;
    savePrefs(prefs);
    dialog.showMessageBox({
      type: 'info',
      message: 'Clawd is connected to Spotify',
      detail: "Now say things like “play hello by adele”.",
      buttons: ['OK'],
    });
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      message: 'Spotify connection failed',
      detail: err.message || String(err),
      buttons: ['OK'],
    });
  } finally {
    spotifyConnecting = false;
    rebuildTrayMenu();
  }
}

function disconnectSpotify() {
  delete prefs.spotifyRefreshToken;
  savePrefs(prefs);
  spotifyAuth.clearCache();
  rebuildTrayMenu();
}

let googleConnecting = false;

async function connectGoogle() {
  if (googleConnecting) return;
  googleConnecting = true;
  rebuildTrayMenu();
  try {
    const tokens = await googleAuth.connect();
    if (!tokens.refresh_token) {
      throw new Error('Google did not return a refresh token. Make sure access_type=offline + prompt=consent are set (they are) and that you haven\'t previously authorized — try revoking at myaccount.google.com/permissions and reconnecting.');
    }
    prefs.googleRefreshToken = tokens.refresh_token;
    savePrefs(prefs);
    dialog.showMessageBox({
      type: 'info',
      message: 'Clawd is connected to Google',
      detail: 'Now ask things like "check my email", "find email from X", "search drive for Y", "read the doc about Z".',
      buttons: ['OK'],
    });
  } catch (err) {
    dialog.showMessageBox({
      type: 'error',
      message: 'Google connection failed',
      detail: err.message || String(err),
      buttons: ['OK'],
    });
  } finally {
    googleConnecting = false;
    rebuildTrayMenu();
  }
}

function disconnectGoogle() {
  delete prefs.googleRefreshToken;
  savePrefs(prefs);
  googleAuth.clearCache();
  rebuildTrayMenu();
}

function showAbout() {
  const spotifyOn = !!prefs.spotifyRefreshToken;
  const googleOn = !!prefs.googleRefreshToken;
  dialog.showMessageBox({
    type: 'info',
    message: `Clawd ${app.getVersion()}`,
    detail:
      'A pixel-art Claude pet for your desktop.\n\n' +
      `Spotify:  ${spotifyOn ? 'connected' : 'not connected'}\n` +
      `Google:   ${googleOn ? 'connected' : 'not connected'}\n` +
      `Personality: ${prefs.personality || 'default'}\n` +
      `Skin: ${prefs.skin || 'default'}\n\n` +
      'Source + updates: github.com/bournechoi4353/ClaudeBuddy',
    buttons: ['OK', 'Open GitHub'],
    defaultId: 0,
  }).then((r) => {
    if (r.response === 1) shell.openExternal('https://github.com/bournechoi4353/ClaudeBuddy');
  });
}

// The tray menu template, shared by the tray icon and the right-click-the-crab
// menu (see the 'open-menu' IPC handler). On Windows the tray icon hides in the
// system-tray overflow, so right-clicking the crab is the primary way to reach
// settings; on macOS it's a handy shortcut. Additive on both platforms.
function buildTrayMenuTemplate() {
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const monitorItems = buildMonitorSubmenu();
  const spotifyConnected = !!prefs.spotifyRefreshToken;
  return [
    { label: 'Preferences…', click: openPreferencesWindow },
    { label: 'About Clawd', click: showAbout },
    { type: 'separator' },
    { label: 'Reset conversation', click: () => agent.reset() },
    { label: 'Size', submenu: buildSizeSubmenu() },
    {
      label: 'Move to monitor',
      submenu: monitorItems,
      enabled: monitorItems.length > 1,
    },
    { type: 'separator' },
    spotifyConnecting
      ? { label: 'Connecting Spotify…', enabled: false }
      : spotifyConnected
      ? { label: 'Disconnect Spotify', click: disconnectSpotify }
      : { label: 'Connect Spotify…', click: connectSpotify },
    googleConnecting
      ? { label: 'Connecting Google…', enabled: false }
      : prefs.googleRefreshToken
      ? { label: 'Disconnect Google', click: disconnectGoogle }
      : { label: 'Connect Google…', click: connectGoogle },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: launchAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Quit Clawd', click: () => app.quit() },
  ];
}

function rebuildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
}

function createTray() {
  const iconPath = path.join(__dirname, 'renderer', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    // Template image = macOS menu-bar tinting. On Windows it would render the
    // tray icon as a flat monochrome mask, so only apply it on macOS.
    if (platform.IS_MAC) icon.setTemplateImage(true);
  } catch (_) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip('Clawd');
  rebuildTrayMenu();
}

// Refresh the monitor list if displays are plugged/unplugged at runtime.
function watchDisplayChanges() {
  const rebuild = () => {
    if (tray) rebuildTrayMenu();
    // If our current monitor was unplugged, retreat to primary.
    const stillExists = screen.getAllDisplays().some((d) => d.id === currentDisplayId);
    if (!stillExists) moveToDisplay(screen.getPrimaryDisplay());
  };
  screen.on('display-added', rebuild);
  screen.on('display-removed', rebuild);
  screen.on('display-metrics-changed', rebuild);
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  maybeShowClaudeOnboarding();
  createMainWindow(screen.getPrimaryDisplay());
  createTray();
  watchDisplayChanges();
  startProactiveMonitor();
  startIdleChatter();
});

app.on('window-all-closed', () => {
  app.quit();
});
