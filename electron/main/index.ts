import { ipcMain } from 'electron';
import { IPC } from './ipc';
import { KernelManager } from './kernel-manager';

const kernelManager = new KernelManager();

// Kernel handlers
ipcMain.handle(IPC.kernels.list, () => kernelManager.list());
ipcMain.handle(IPC.kernels.start, (_event, spec) => kernelManager.start(spec));
ipcMain.handle(IPC.kernels.stop, (_event, id) => kernelManager.stop(id));
ipcMain.handle(IPC.kernels.execute, (_event, id, req) => kernelManager.execute(id, req));
ipcMain.handle(IPC.kernels.interrupt, (_event, id) => kernelManager.interrupt(id));
ipcMain.handle(IPC.kernels.restart, (_event, id) => kernelManager.restart(id));
ipcMain.handle(IPC.kernels.complete, (_event, id, code, pos) => kernelManager.complete(id, code, pos));
ipcMain.handle(IPC.kernels.inspect, (_event, id, code, pos) => kernelManager.inspect(id, code, pos));

// Tree handlers (stub)
ipcMain.handle(IPC.tree.list, (_event, treePath) => {
  // Stub:  return empty array; real impl will use file-service
  console.log('tree:list', treePath);
  return [];
});

ipcMain.handle(IPC.tree.get, (_event, id) => {
  console.log('tree:get', id);
  return null;
});

ipcMain.handle(IPC.tree. save, (_event, id, payload) => {
  console.log('tree:save', id, payload);
  return true;
});

// Files handlers (stub)
ipcMain.handle(IPC.files. read, (_event, filePath, opts) => {
  console.log('files:read', filePath, opts);
  return null;
});

ipcMain.handle(IPC.files.write, (_event, filePath, content) => {
  console.log('files:write', filePath, content);
  return true;
});

// Config handlers (stub)
ipcMain.handle(IPC.config. get, () => {
  return { kernelSpec: null, plotMode: 'native', cwd: process.cwd(), trusted: false };
});

ipcMain.handle(IPC.config.set, (_event, cfg) => {
  console.log('config:set', cfg);
  return true;
});