const { contextBridge } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  createWindow: (options) => {
    // Window creation would be handled via IPC if needed
    return Promise.resolve({ success: true });
  }
});
