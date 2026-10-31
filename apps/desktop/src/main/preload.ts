import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('eluvixAPI', {
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  // Desktop API token, handed to the renderer by the main process so its
  // direct fetches to the local server can authenticate (audit C-1,
  // decision D1). The token is never served over the HTTP API itself.
  getDesktopToken: () => ipcRenderer.invoke('get-desktop-token'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  detectModels: (params?: any) => ipcRenderer.invoke('detect-models', params),
  onRequestLogged: (callback: (log: any) => void) => {
    ipcRenderer.on('request-logged', (_event, log) => callback(log));
  },
  onConfigUpdated: (callback: (config: any) => void) => {
    ipcRenderer.on('config-updated', (_event, config) => callback(config));
  },
  getProviderStatus: () => ipcRenderer.invoke('get-provider-status'),
  toggleProvider: (enabled: boolean) => ipcRenderer.invoke('toggle-provider', enabled),
  saveProviderConfig: (config: any) => ipcRenderer.invoke('save-provider-config', config),
  runProviderBenchmark: (model?: string) => ipcRenderer.invoke('run-provider-benchmark', model),
  getProviderJobs: (limit?: number) => ipcRenderer.invoke('get-provider-jobs', limit),
  onProviderStatusChanged: (callback: (status: any) => void) => {
    ipcRenderer.on('provider-status-changed', (_event, status) => callback(status));
  },
  onProviderJobCompleted: (callback: (job: any) => void) => {
    ipcRenderer.on('provider-job-completed', (_event, job) => callback(job));
  },
  // External links: http(s) only (audit M-22, decision D2). Handled in the main process.
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  copyToClipboard: (text: string) => ipcRenderer.invoke('copy-to-clipboard', text)
});
