const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

// Force subscription auth: ignore any inherited API key so credits come from Claude Pro/Max.
delete process.env.ANTHROPIC_API_KEY;
// Strip parent Claude Code session vars so the SDK starts clean rather than thinking it's nested.
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'AI_AGENT') {
    delete process.env[k];
  }
}

const agent = require('./agent');

function createWindow() {
  // Span ALL connected displays so Clawd can walk across monitors.
  // We take the bounding box of every display's workArea (excludes menubar + dock
  // per display). Gaps between non-tiled monitors become dead zones — fine for
  // typical horizontal arrangements.
  const displays = screen.getAllDisplays();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const d of displays) {
    const wa = d.workArea;
    minX = Math.min(minX, wa.x);
    minY = Math.min(minY, wa.y);
    maxX = Math.max(maxX, wa.x + wa.width);
    maxY = Math.max(maxY, wa.y + wa.height);
  }
  const wx = minX, wy = minY, ww = maxX - minX, wh = maxY - minY;

  // Per-monitor segments in window coords. Each segment has its own X range
  // and bottomY so Clawd stays on each monitor's visible area, even when
  // monitors are at different vertical offsets or have gaps between them.
  const segments = displays
    .map((d) => ({
      leftX: d.workArea.x - wx,
      rightX: d.workArea.x + d.workArea.width - wx,
      bottomY: d.workArea.y + d.workArea.height - wy,
    }))
    .sort((a, b) => a.leftX - b.leftX);

  const win = new BrowserWindow({
    width: ww,
    height: wh,
    x: wx,
    y: wy,
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

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  ipcMain.on('set-ignore-mouse', (_event, ignore) => {
    win.setIgnoreMouseEvents(ignore, { forward: true });
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

  ipcMain.handle('clawd:get-layout', () => ({ segments }));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  startAppSwitchWatcher(win);
}

const { spawn } = require('child_process');
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
  const tick = async () => {
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
  };
  setInterval(tick, 2000);
}

let tray = null;
function rebuildTrayMenu() {
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const menu = Menu.buildFromTemplate([
    { label: 'Reset conversation', click: () => agent.reset() },
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

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  app.quit();
});
