const { app, BrowserWindow, screen, ipcMain } = require('electron');
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
  // Cover the workArea (excludes menubar + dock). The dock renders above
  // floating windows on macOS, so going edge-to-edge hides Clawd's legs.
  // workArea bottom = top of dock, which is the lowest spot we can show legs.
  const display = screen.getPrimaryDisplay();
  const { x: wx, y: wy, width: ww, height: wh } = display.workArea;

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

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
