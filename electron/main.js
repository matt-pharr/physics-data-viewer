const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

function createWindow() {
  // Check if dist folder exists
  const distPath = path.join(__dirname, 'dist', 'index.html');
  if (!fs.existsSync(distPath)) {
    dialog.showErrorBox(
      'Build Required',
      'The frontend has not been built yet.\n\n' +
      'Please run the following commands:\n' +
      '1. cd electron\n' +
      '2. npm install (if not done yet)\n' +
      '3. npm run build\n\n' +
      'Or simply run: npm start\n' +
      '(which will build automatically)'
    );
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Load the index.html
  mainWindow.loadFile('dist/index.html');

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers for window management
ipcMain.handle('create-window', async (event, options) => {
  const newWindow = new BrowserWindow({
    width: options.width || 800,
    height: options.height || 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  newWindow.loadFile('dist/index.html');
  return { windowId: newWindow.id };
});
