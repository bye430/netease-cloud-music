const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricsApi', {
  onUpdate: (callback) => {
    ipcRenderer.on('lyrics-update', (_event, data) => callback(data));
  },
  onPinState: (callback) => {
    ipcRenderer.on('lyrics-pin-state', (_event, pinned) => callback(pinned));
  },
  getPinState: () => ipcRenderer.invoke('lyrics:get-pin-state'),
  getSettings: () => ipcRenderer.invoke('lyrics:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('lyrics:save-settings', settings),
  getFontList: () => ipcRenderer.invoke('lyrics:get-font-list'),
  onSettingsUpdate: (callback) => {
    ipcRenderer.on('lyrics-settings-update', (_event, settings) => callback(settings));
  },
  onSettingsPanelClose: (callback) => {
    ipcRenderer.on('lyrics-settings-panel-close', () => callback());
  },
  close: () => ipcRenderer.send('lyrics-close'),
  togglePin: () => ipcRenderer.invoke('lyrics:toggle-pin'),
  setSettingsOpen: (open, panelHeight) =>
    ipcRenderer.invoke('lyrics:set-settings-open', open, panelHeight),
});
