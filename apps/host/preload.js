'use strict';
// The whole bridge. Named channels only, no generic invoke passthrough: the
// renderer can ask for exactly these things and nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cs', {
  status: (opts) => ipcRenderer.invoke('status', opts),
  previewFixes: () => ipcRenderer.invoke('fix:preview'),
  applyFixes: (opts) => ipcRenderer.invoke('fix:apply', opts),
  restartService: () => ipcRenderer.invoke('service:restart'),
  planFirewall: () => ipcRenderer.invoke('firewall:plan'),
  verify: (opts) => ipcRenderer.invoke('verify:run', opts),
  previewApps: () => ipcRenderer.invoke('apps:preview'),
  applyApps: (opts) => ipcRenderer.invoke('apps:apply', opts),
  sessionState: () => ipcRenderer.invoke('session:state'),
  closeSession: () => ipcRenderer.invoke('session:close'),
  pairingState: () => ipcRenderer.invoke('pairing:state'),
  saveCredentials: (c) => ipcRenderer.invoke('pairing:saveCredentials', c),
  forgetCredentials: () => ipcRenderer.invoke('pairing:forgetCredentials'),
  submitPin: (o) => ipcRenderer.invoke('pairing:submitPin', o),
  unpair: (o) => ipcRenderer.invoke('pairing:unpair', o),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('open:external', url)
});
