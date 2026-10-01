'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('r7', {
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkPath: (p, cwd, home) => ipcRenderer.invoke('path:check', p, cwd, home),
  openPath: (win) => ipcRenderer.send('path:open', win),
  openImage: (dataUrl) => ipcRenderer.send('image:open', dataUrl),
  log: (lvl, ev, data) => ipcRenderer.send('log', lvl, ev, data || {}),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  toggleFullscreen: () => ipcRenderer.send('fullscreen'),
  newWindow: (template) => ipcRenderer.send('new-window', template),
  closeWindow: () => ipcRenderer.send('close-window'),
  saveFontSize: (template, size) => ipcRenderer.send('font-size', template, size),
  onExtra: (channel, fn) => ipcRenderer.on(`x:${channel}`, (_e, data) => fn(data)),
  onDone: (fn) => ipcRenderer.on('done', () => fn()),
  onPins: (fn) => ipcRenderer.on('pins', (_e, entries) => fn(entries)),
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, look) => fn(look)),
});
