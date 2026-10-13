'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cs', {
  hosts: () => ipcRenderer.invoke('hosts'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  startPairing: (opts) => ipcRenderer.invoke('pair:start', opts),
  launch: (opts) => ipcRenderer.invoke('launch', opts),
  quit: (opts) => ipcRenderer.invoke('quit', opts),
  openMoonlight: () => ipcRenderer.invoke('open:moonlight'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url)
});
