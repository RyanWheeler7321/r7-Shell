const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewer', {
  close: () => ipcRenderer.send('viewer:close'),
  toggleFullscreen: () => ipcRenderer.send('viewer:fullscreen'),
  showInFolder: () => ipcRenderer.send('viewer:folder'),
});
