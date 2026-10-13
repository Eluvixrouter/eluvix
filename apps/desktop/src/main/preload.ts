import { contextBridge, ipcRenderer, shell, clipboard } from 'electron';

contextBridge.exposeInMainWorld('eluvixAPI', {
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: any) => ipcRenderer.invoke('save-config', config),
  detectModels: (params?: any) => ipcRenderer.invoke('detect-models', params),
  onRequestLogged: (callback: (log: any) => void) => {
    ipcRenderer.on('request-logged', (_event, log) => callback(log));
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
  openExternal: (url: string) => shell.openExternal(url),
  copyToClipboard: (text: string) => clipboard.writeText(text)
});
