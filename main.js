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

ipcMain.on('chat-send', async (event, text) => {
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

function osascriptOnce(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`osa ${code}`))));
    p.on('error', reject);
  });
}

function startAppSwitchWatcher(win) {
  let lastFront = null;
  setInterval(async () => {
    try {
      const front = await osascriptOnce(
        'tell application "System Events" to return name of first application process whose frontmost is true'
      );
      if (lastFront !== null && front && front !== lastFront && !win.isDestroyed()) {
        win.webContents.send('clawd-react', { type: 'app-switch', app: front });
      }
      lastFront = front;
    } catch (_) {
      // ignore — Clawd just won't react this tick
    }
  }, 2000);
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

function rebuildTrayMenu() {
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const monitorItems = buildMonitorSubmenu();
  const menu = Menu.buildFromTemplate([
    { label: 'Reset conversation', click: () => agent.reset() },
    { label: 'Size', submenu: buildSizeSubmenu() },
    {
      label: 'Move to monitor',
      submenu: monitorItems,
      enabled: monitorItems.length > 1,
    },
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
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('clawd');
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
  createMainWindow(screen.getPrimaryDisplay());
  createTray();
  watchDisplayChanges();
});

app.on('window-all-closed', () => {
  app.quit();
});
