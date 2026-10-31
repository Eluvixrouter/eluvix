import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, clipboard } from 'electron';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DesktopRouterServer } from './server.js';
import { getProviderSettings, getProviderJobLogs } from '@eluvix/router-core';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let server: DesktopRouterServer | null = null;
let tray: Tray | null = null;

/** Only https:/http: URLs may be handed to the OS (audit M-22, decision D2). */
function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * IPC handlers serve only the app's own local renderer. A frame that is
 * not a file:// page (e.g. remote content that somehow got loaded into a
 * webContents with the preload bridge attached) gets nothing (audit M-22).
 */
function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const frameUrl = event.senderFrame?.url || '';
  if (!frameUrl.startsWith('file://')) {
    throw new Error('IPC rejected: untrusted sender frame');
  }
}

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
  const rendererUrl = pathToFileURL(rendererPath).href;

  // Window-open and navigation lockdown (audit M-22): the window exists to
  // show the local renderer only. New windows are denied (validated
  // http(s) links go to the system browser instead), and navigation away
  // from the renderer file is blocked — remote content must never load in
  // a webContents that carries the eluvixAPI preload bridge.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererUrl) {
      event.preventDefault();
    }
  });

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
  ipcMain.handle('get-server-status', (event) => {
    assertTrustedSender(event);
    if (!server) return { status: 'stopped', port: null, endpoint: null, tls: false };
    const port = server.getPort();
    const baseUrl = server.getBaseUrl();
    const tls = server.getIsHttps();
    return {
      status: 'running',
      port,
      tls,
      endpoint: `${baseUrl}/v1`,
      healthUrl: `${baseUrl}/health`,
      tokenFile: server.getDesktopTokenFile()
    };
  });

  // The desktop API token reaches the renderer ONLY over this IPC channel
  // (audit C-1, decision D1) — it is never served by the HTTP API itself.
  ipcMain.handle('get-desktop-token', (event) => {
    assertTrustedSender(event);
    return server ? server.getDesktopToken() : null;
  });

  ipcMain.handle('get-config', (event) => {
    assertTrustedSender(event);
    return server ? server.getConfig() : null;
  });

  ipcMain.handle('save-config', (event, newConfig) => {
    assertTrustedSender(event);
    if (server) {
      server.updateConfig(newConfig);
      return { success: true, config: server.getConfig() };
    }
    return { success: false, error: 'Server not initialized' };
  });

  ipcMain.handle('detect-models', async (event, params) => {
    assertTrustedSender(event);
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
  ipcMain.handle('get-provider-status', async (event) => {
    assertTrustedSender(event);
    if (!server) return { success: false, error: 'Server not ready' };
    const status = await server.getProviderStatus();
    const settings = getProviderSettings();
    const recentJobs = getProviderJobLogs(15);
    return { success: true, status, settings, recentJobs };
  });

  ipcMain.handle('toggle-provider', async (event, enabled: boolean) => {
    assertTrustedSender(event);
    if (!server) return { success: false, error: 'Server not ready' };
    const status = await server.toggleProvider(enabled);
    return { success: true, status };
  });

  ipcMain.handle('save-provider-config', (event, config) => {
    assertTrustedSender(event);
    if (!server) return { success: false, error: 'Server not ready' };
    const settings = server.updateProviderConfig(config);
    return { success: true, settings };
  });

  ipcMain.handle('run-provider-benchmark', async (event, model?: string) => {
    assertTrustedSender(event);
    if (!server) return { success: false, error: 'Server not ready' };
    const result = await server.runProviderBenchmark(model);
    const status = await server.getProviderStatus();
    return { success: true, result, status };
  });

  ipcMain.handle('get-provider-jobs', (event, limit?: number) => {
    assertTrustedSender(event);
    const jobs = getProviderJobLogs(limit || 20);
    return { success: true, jobs };
  });

  ipcMain.handle('open-external', async (event, url: string) => {
    assertTrustedSender(event);
    if (isSafeExternalUrl(url)) {
      await shell.openExternal(url);
      return true;
    }
    throw new Error('Only http(s) links can be opened externally');
  });

  ipcMain.handle('copy-to-clipboard', (event, text: string) => {
    assertTrustedSender(event);
    clipboard.writeText(String(text ?? ''));
    return true;
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
