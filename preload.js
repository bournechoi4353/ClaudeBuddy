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
  resetChat: () => ipcRenderer.send('chat-reset'),
  getLayout: () => ipcRenderer.invoke('clawd:get-layout'),
});
