const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// Force subscription auth: ignore any inherited API key so credits come from Claude Pro/Max.
delete process.env.ANTHROPIC_API_KEY;
// Strip parent Claude Code session vars so the SDK starts clean rather than thinking it's nested.
for (const k of Object.keys(process.env)) {
  if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k === 'AI_AGENT') {
    delete process.env[k];
  }
}

const agent = require('./agent');

// One BrowserWindow per display, each sized to that monitor's workArea.
// macOS reliably renders single-monitor windows; a window spanning displays
// is often invisibly clipped to one of them.
const allWindows = []; // [{ win, display, idx }]
let activeMonitorIdx = 0;

function createAllWindows() {
  const displays = screen.getAllDisplays().sort((a, b) => a.bounds.x - b.bounds.x);
  const total = displays.length;

  displays.forEach((display, idx) => {
    const wa = display.workArea;
    const win = new BrowserWindow({
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

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.setIgnoreMouseEvents(true, { forward: true });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
      search: `monitor=${idx}&total=${total}`,
    });

    allWindows.push({ win, display, idx });
  });
}

function senderWindow(event) {
  const w = BrowserWindow.fromWebContents(event.sender);
  return allWindows.find((it) => it.win === w);
}

ipcMain.on('set-ignore-mouse', (event, ignore) => {
  const item = senderWindow(event);
  if (item) item.win.setIgnoreMouseEvents(ignore, { forward: true });
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

// Hand Clawd off from one window to the adjacent one (by display X order).
ipcMain.handle('clawd:cross-monitor', (event, payload) => {
  const sender = senderWindow(event);
  if (!sender) return { crossed: false };
  const direction = payload && payload.direction;
  const targetIdx = direction === 'right' ? sender.idx + 1 : sender.idx - 1;
  if (targetIdx < 0 || targetIdx >= allWindows.length) return { crossed: false };

  activeMonitorIdx = targetIdx;
  sender.win.webContents.send('clawd-set-active', { active: false });
  allWindows[targetIdx].win.webContents.send('clawd-set-active', {
    active: true,
    edge: direction === 'right' ? 'left' : 'right',
  });
  return { crossed: true };
});

function osascriptOnce(script) {
  return new Promise((resolve, reject) => {
    const p = spawn('osascript', ['-e', script]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`osa ${code}`))));
    p.on('error', reject);
  });
}

function startAppSwitchWatcher() {
  let lastFront = null;
  const tick = async () => {
    try {
      const front = await osascriptOnce(
        'tell application "System Events" to return name of first application process whose frontmost is true'
      );
      if (lastFront !== null && front && front !== lastFront) {
        const active = allWindows[activeMonitorIdx];
        if (active && !active.win.isDestroyed()) {
          active.win.webContents.send('clawd-react', { type: 'app-switch', app: front });
        }
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
  createAllWindows();
  startAppSwitchWatcher();
  createTray();
});

app.on('window-all-closed', () => {
  app.quit();
});
