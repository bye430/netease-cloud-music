const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shortcutsApi', {
  getConfig: () => ipcRenderer.invoke('shortcuts:get-config'),
  saveAndApply: (config) => ipcRenderer.invoke('shortcuts:save-and-apply', config),
  installSystemCtl: () => ipcRenderer.invoke('shortcuts:install-system-ctl'),
  uninstallSystemCtl: () => ipcRenderer.invoke('shortcuts:uninstall-system-ctl'),
  getSystemCtlStatus: () => ipcRenderer.invoke('shortcuts:system-ctl-status'),
});
