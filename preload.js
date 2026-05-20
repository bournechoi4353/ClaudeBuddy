const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crabAPI', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  sendChatMessage: (text) => ipcRenderer.send('chat-send', text),
  onChatPiece: (callback) => {
    ipcRenderer.on('chat-piece', (_e, piece) => callback(piece));
  },
  onReact: (callback) => {
    ipcRenderer.on('clawd-react', (_e, payload) => callback(payload));
  },
  onSetScale: (callback) => {
    ipcRenderer.on('clawd-set-scale', (_e, info) => callback(info));
  },
  onTimerEnded: (callback) => {
    ipcRenderer.on('clawd-timer-ended', (_e, info) => callback(info));
  },
  resetChat: () => ipcRenderer.send('chat-reset'),
});
