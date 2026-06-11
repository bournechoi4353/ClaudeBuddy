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
  onNotify: (callback) => {
    ipcRenderer.on('clawd-notify', (_e, info) => callback(info));
  },
  onTtsAudio: (callback) => {
    ipcRenderer.on('clawd-tts-audio', (_e, info) => callback(info));
  },
  onTtsStop: (callback) => {
    ipcRenderer.on('clawd-tts-stop', () => callback());
  },
  // Voice input (mic button in the chat panel).
  requestMic: () => ipcRenderer.invoke('mic:request'),
  warmStt: () => ipcRenderer.invoke('stt:warm'),
  transcribe: (samples) => ipcRenderer.invoke('stt:transcribe', samples),
  // Hands-free wake word: main toggles it on/off.
  onHandsFree: (callback) => {
    ipcRenderer.on('clawd-hands-free', (_e, info) => callback(info));
  },
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPref: (updates) => ipcRenderer.send('prefs:set', updates),
  onPrefsUpdated: (callback) => {
    ipcRenderer.on('prefs-updated', (_e, updates) => callback(updates));
  },
  resetChat: () => ipcRenderer.send('chat-reset'),
  openMenu: () => ipcRenderer.send('open-menu'),
});
