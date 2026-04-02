'use strict';
// Preload script — runs in a privileged context before the renderer page loads.
// contextIsolation: true means this is the ONLY bridge between Node.js and the
// browser page. We intentionally expose nothing: the app talks to its own
// Express server via normal fetch/XHR calls, so no Node.js APIs are needed here.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronApp', {
  platform: process.platform,
});
