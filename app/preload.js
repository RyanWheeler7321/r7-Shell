'use strict';
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

// A webview cannot see its host panel being hidden by CSS.
ipcRenderer.on('host-visibility', (_event, visible) => {
  const setVisibility = (shown) => {
    const wasHidden = document.hidden;
    const hidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
    const state = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState').get;
    Object.defineProperties(document, {
      hidden: { configurable: true, get: () => !shown || hidden.call(document) },
      visibilityState: { configurable: true, get: () => shown ? state.call(document) : 'hidden' },
    });
    let style = document.getElementById('r7-host-visibility');
    if (!style) {
      style = document.createElement('style');
      style.id = 'r7-host-visibility';
      style.textContent = 'html[data-r7-host-hidden] { visibility: hidden !important; } html[data-r7-host-hidden] *, html[data-r7-host-hidden] *::before, html[data-r7-host-hidden] *::after { animation-play-state: paused !important; }';
      document.head.appendChild(style);
    }
    document.documentElement.toggleAttribute('data-r7-host-hidden', !shown);
    if (wasHidden !== document.hidden) document.dispatchEvent(new Event('visibilitychange'));
  };
  // Support hosts without contextBridge.executeInMainWorld.
  webFrame.executeJavaScript(`(${setVisibility.toString()})(${visible === true})`)
    .catch((error) => console.error('Host visibility failed', error));
});

// Small values pages keep between runs (launch pace and model chips), held by
// the main process instead of localStorage: a restart runs two copies of the app at once
// (main.js restartHandoff), each on its own browser profile. Values still only in this
// profile's localStorage move over the first time they're read.
const storeCache = new Map(), storePending = new Map();
ipcRenderer.on('store:changed', (_event, key, value, own) => {
  if (own) {
    const remaining = (storePending.get(key) || 0) - 1;
    if (remaining > 0) storePending.set(key, remaining);
    else storePending.delete(key);
  }
  if (!storePending.has(key) && storeCache.has(key)) storeCache.set(key, value ?? null);
});
function storeWrite(key, value) {
  storeCache.set(key, value);
  storePending.set(key, (storePending.get(key) || 0) + 1);
  ipcRenderer.send('store:set', key, value);
}
const store = {
  getItem(key) {
    if (storeCache.has(key)) return storeCache.get(key);
    let value = ipcRenderer.sendSync('store:get', key);
    if (value == null) {
      try { value = localStorage.getItem(key); localStorage.removeItem(key); } catch {}
      if (value != null) storeWrite(key, value);
    }
    storeCache.set(key, value ?? null);
    return value ?? null;
  },
  setItem: (key, value) => storeWrite(key, String(value)),
  removeItem: (key) => {
    try { localStorage.removeItem(key); } catch {}
    storeWrite(key, null);
  },
};

contextBridge.exposeInMainWorld('r7', {
  store,
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  snapshot: (rect) => ipcRenderer.invoke('window:snapshot', rect),
  clipboardImage: (session) => ipcRenderer.invoke('clipboard:image', session),
  pathForFile: (file) => webUtils.getPathForFile(file),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  checkPath: (p, cwd, home) => ipcRenderer.invoke('path:check', p, cwd, home),
  fileVersion: (p) => ipcRenderer.invoke('file:version', p),
  openPath: (win) => ipcRenderer.send('path:open', win),
  openImage: (dataUrl) => ipcRenderer.send('image:open', dataUrl),
  pictureMenu: (target, x, y) => ipcRenderer.send('picture:menu', target, x, y),
  log: (lvl, ev, data) => ipcRenderer.send('log', lvl, ev, data || {}),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  toggleFullscreen: () => ipcRenderer.send('fullscreen'),
  newWindow: (template) => ipcRenderer.send('new-window', template),
  closeWindow: () => ipcRenderer.send('close-window'),
  finishFlash: (on, completedMs, color) => ipcRenderer.send('finish-flash', on, completedMs, color),
  saveFontSize: (template, size) => ipcRenderer.send('font-size', template, size),
  saveZoom: (template, kind, value) => ipcRenderer.send('zoom', template, kind, value),
  onExtra: (channel, fn) => ipcRenderer.on(`x:${channel}`, (_e, data) => fn(data)),
  turnEnd: () => ipcRenderer.send('turn-end'),
  onDone: (fn) => ipcRenderer.on('done', () => fn()),
  onPins: (fn) => ipcRenderer.on('pins', (_e, entries) => fn(entries)),
  onPanel: (fn) => ipcRenderer.on('panel', (_e, state) => fn(state)),
  panelClick: (id) => ipcRenderer.send('panel:click', String(id)),
  onCursor: (fn) => ipcRenderer.on('cursor', (_e, look) => fn(look)),
});
