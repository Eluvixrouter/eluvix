import os from 'node:os';
import path from 'node:path';

export function getAppPaths(appName = 'eluvix') {
  const home = os.homedir();
  const platform = os.platform();

  let configDir: string;
  let dataDir: string;

  if (platform === 'win32') {
    configDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, appName)
      : path.join(home, 'AppData', 'Roaming', appName);
    dataDir = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, appName)
      : path.join(home, 'AppData', 'Local', appName);
  } else if (platform === 'darwin') {
    configDir = path.join(home, 'Library', 'Application Support', appName);
    dataDir = configDir; // macOS conventionally uses the same for both config and data
  } else {
    // Linux / Standard XDG
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    configDir = path.join(xdgConfig, appName);

    const xdgData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    dataDir = path.join(xdgData, appName);
  }

  const layoutsDir = path.join(configDir, 'layouts');

  return { configDir, dataDir, layoutsDir };
}
