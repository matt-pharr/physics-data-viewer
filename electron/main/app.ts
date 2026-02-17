import { app, BrowserWindow, Menu } from 'electron';
import * as path from 'path';
import './index'; // Register IPC handlers (even if empty for now)

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1e1e1e',
  });

  // Disable reload shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Prevent Cmd+R, Ctrl+R, F5 from reloading the page
    if (
      (input.key === 'r' || input.key === 'R') &&
      (input.control || input.meta) &&
      input.type === 'keyDown'
    ) {
      event.preventDefault();
    }
    if (input.key === 'F5' && input.type === 'keyDown') {
      event.preventDefault();
    }
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const canCreateWindow = typeof app?.whenReady === 'function';

if (!canCreateWindow) {
  console.warn('[main] Electron app not available (likely test environment); skipping window creation.');
} else {
  app.whenReady().then(() => {
    // Set up application menu without reload shortcuts
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'File',
        submenu: [
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      }
    ];

    // Add dev menu only in development
    if (isDev) {
      template.push({
        label: 'Developer',
        submenu: [
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { 
            label: 'Reload (Use with caution)',
            accelerator: 'CommandOrControl+Shift+R',
            click: (_, window) => {
              if (window) {
                window.reload();
              }
            }
          }
        ]
      });
    }

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

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
}
