import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAppPaths } from './paths.js';

export interface TlsCertificates {
  certPath: string;
  keyPath: string;
  cert: Buffer;
  key: Buffer;
}

/**
 * Checks if mkcert is installed and executable in PATH.
 */
export function isMkcertAvailable(): boolean {
  try {
    const result = spawnSync('mkcert', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensures a valid TLS certificate and key exist for local HTTPS.
 * If mkcert is available, generates or retrieves existing certs from the config/tls directory.
 * Returns null if mkcert is not available or certificate generation fails.
 */
export function getOrCreateLocalCert(
  domains: string[] = ['localhost', '127.0.0.1', '::1', 'eluvix.local']
): TlsCertificates | null {
  if (!isMkcertAvailable()) {
    return null;
  }

  const { configDir } = getAppPaths('eluvix');
  const tlsDir = path.join(configDir, 'tls');

  if (!fs.existsSync(tlsDir)) {
    fs.mkdirSync(tlsDir, { recursive: true });
  }

  const certPath = path.join(tlsDir, 'eluvix.pem');
  const keyPath = path.join(tlsDir, 'eluvix-key.pem');

  // If both cert and key already exist and have content, return them
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      if (cert.length > 0 && key.length > 0) {
        return { certPath, keyPath, cert, key };
      }
    } catch (err) {
      console.warn('[TLS] Existing certs could not be read, regenerating...', err);
    }
  }

  try {
    console.log(`[TLS] Generating TLS certificate using mkcert for: ${domains.join(', ')}...`);
    // Ensure local CA is installed (safe to call multiple times)
    execSync('mkcert -install', { stdio: 'ignore' });

    // Generate certificates
    execSync(
      `mkcert -cert-file "${certPath}" -key-file "${keyPath}" ${domains.map(d => `"${d}"`).join(' ')}`,
      { stdio: 'inherit' }
    );

    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);

    return {
      certPath,
      keyPath,
      cert,
      key
    };
  } catch (err) {
    console.error('[TLS] Failed to generate certificate with mkcert:', err);
    return null;
  }
}
