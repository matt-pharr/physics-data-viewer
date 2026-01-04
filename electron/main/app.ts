import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import './index'; // Register IPC handlers

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
  const mainWindow = new BrowserWindow({
    width:  1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '.. ', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});