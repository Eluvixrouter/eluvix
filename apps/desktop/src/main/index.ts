import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import path from 'node:path';
import { DesktopRouterServer } from './server';
import { getProviderSettings, getProviderJobLogs } from '@eluvix/router-core';

let mainWindow: BrowserWindow | null = null;
let server: DesktopRouterServer | null = null;
let tray: Tray | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 740,
    minWidth: 840,
    minHeight: 560,
    title: 'Eluvix Desktop',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
  await mainWindow.loadFile(rendererPath);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function initServer() {
  server = new DesktopRouterServer(3001);

  server.on('request-logged', (log) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('request-logged', log);
    }
  });

  server.on('config-updated', (config) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('config-updated', config);
    }
  });

  server.on('provider-status-changed', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('provider-status-changed', status);
    }
  });

  server.on('provider-job-completed', (job) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('provider-job-completed', job);
    }
  });

  const port = await server.start();
  console.log(`[Eluvix Desktop] Local OpenAI proxy ready on port ${port}`);
}

function setupIpcHandlers() {
  ipcMain.handle('get-server-status', () => {
    if (!server) return { status: 'stopped', port: null, endpoint: null, tls: false };
    const port = server.getPort();
    const baseUrl = server.getBaseUrl();
    const tls = server.getIsHttps();
    return {
      status: 'running',
      port,
      tls,
      endpoint: `${baseUrl}/v1`,
      healthUrl: `${baseUrl}/health`
    };
  });

  ipcMain.handle('get-config', () => {
    return server ? server.getConfig() : null;
  });

  ipcMain.handle('save-config', (_event, newConfig) => {
    if (server) {
      server.updateConfig(newConfig);
      return { success: true, config: server.getConfig() };
    }
    return { success: false, error: 'Server not initialized' };
  });

  ipcMain.handle('detect-models', async (_event, params) => {
    if (!server) return { success: false, error: 'Server not initialized' };

    if (params?.all) {
      const detectedMap = await server.detectAllModels(5000);
      const currentConfig = server.getConfig();
      currentConfig.upstreams.forEach(u => {
        if (detectedMap[u.id] && detectedMap[u.id].length > 0) {
          u.models = detectedMap[u.id];
        }
      });
      server.updateConfig(currentConfig);
      return { success: true, detected: detectedMap, config: currentConfig };
    }

    const currentConfig = server.getConfig();
    let target = currentConfig.upstreams.find(u => u.id === params?.id);
    if (!target && params?.endpoint) {
      target = {
        id: params.id || 'custom-detect',
        name: params.name || 'Custom Node',
        type: params.type || 'openai-compatible',
        endpoint: params.endpoint,
        apiKey: params.apiKey,
        priority: 1,
        models: []
      };
    }

    if (!target) {
      return { success: false, error: 'Upstream not found' };
    }

    const detected = await server.detectModels(target, 5000);
    if (detected.length > 0 && target.id !== 'custom-detect') {
      target.models = detected;
      server.updateConfig(currentConfig);
    }

    return {
      success: true,
      id: target.id,
      models: detected,
      count: detected.length,
      message: detected.length > 0
        ? `Successfully detected ${detected.length} model(s).`
        : `No models detected at ${target.endpoint}. Make sure the server is running.`
    };
  });

  // Provider IPC handlers for GPU monetization
  ipcMain.handle('get-provider-status', async () => {
    if (!server) return { success: false, error: 'Server not ready' };
    const status = await server.getProviderStatus();
    const settings = getProviderSettings();
    const recentJobs = getProviderJobLogs(15);
    return { success: true, status, settings, recentJobs };
  });

  ipcMain.handle('toggle-provider', async (_event, enabled: boolean) => {
    if (!server) return { success: false, error: 'Server not ready' };
    const status = await server.toggleProvider(enabled);
    return { success: true, status };
  });

  ipcMain.handle('save-provider-config', (_event, config) => {
    if (!server) return { success: false, error: 'Server not ready' };
    const settings = server.updateProviderConfig(config);
    return { success: true, settings };
  });

  ipcMain.handle('run-provider-benchmark', async (_event, model?: string) => {
    if (!server) return { success: false, error: 'Server not ready' };
    const result = await server.runProviderBenchmark(model);
    const status = await server.getProviderStatus();
    return { success: true, result, status };
  });

  ipcMain.handle('get-provider-jobs', (_event, limit?: number) => {
    const jobs = getProviderJobLogs(limit || 20);
    return { success: true, jobs };
  });
}

app.whenReady().then(async () => {
  setupIpcHandlers();
  await initServer();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (server) {
      server.stop().finally(() => app.quit());
    } else {
      app.quit();
    }
  }
});

app.on('before-quit', async () => {
  if (server) {
    await server.stop();
  }
});
