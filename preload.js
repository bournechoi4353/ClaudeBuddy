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
  // Pet brain (only fires when PET_BRAIN_LOCAL=1).
  onPetState: (callback) => {
    ipcRenderer.on('pet-brain-state', (_e, info) => callback(info));
  },
  onPetBubble: (callback) => {
    ipcRenderer.on('pet-brain-bubble', (_e, info) => callback(info));
  },
  onPetWeather: (callback) => {
    ipcRenderer.on('pet-brain-weather', (_e, info) => callback(info));
  },
  findPlaces: (name) => ipcRenderer.invoke('pet-brain:geocode', name),
  onPetDebug: (callback) => {
    ipcRenderer.on('pet-brain-debug', (_e, info) => callback(info));
  },
  resetPetLines: () => ipcRenderer.send('pet-brain:reset-lines'),
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPref: (updates) => ipcRenderer.send('prefs:set', updates),
  onPrefsUpdated: (callback) => {
    ipcRenderer.on('prefs-updated', (_e, updates) => callback(updates));
  },
  resetChat: () => ipcRenderer.send('chat-reset'),
  openMenu: () => ipcRenderer.send('open-menu'),
});
