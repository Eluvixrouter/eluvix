import { spawnSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
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

/** Expands an IPv6 address to its full eight-group form for SAN comparison. */
function normalizeIpv6(ip: string): string {
  let addr = ip.toLowerCase();
  const zoneIdx = addr.indexOf('%');
  if (zoneIdx >= 0) addr = addr.slice(0, zoneIdx);
  if (addr.includes('::')) {
    const [head, tail] = addr.split('::');
    const headGroups = head ? head.split(':') : [];
    const tailGroups = tail ? tail.split(':') : [];
    const missing = 8 - headGroups.length - tailGroups.length;
    const groups = [...headGroups, ...Array(Math.max(missing, 0)).fill('0'), ...tailGroups];
    return groups.map(g => g.padStart(4, '0')).join(':');
  }
  return addr
    .split(':')
    .map(g => g.padStart(4, '0'))
    .join(':');
}

function isIpLiteral(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

function ipEquals(a: string, b: string): boolean {
  if (a.includes(':') || b.includes(':')) {
    try {
      return normalizeIpv6(a) === normalizeIpv6(b);
    } catch {
      return false;
    }
  }
  return a === b;
}

/**
 * Validates that an existing cert/key pair is safe to reuse for the
 * requested domains (audit M-16): the certificate parses, is inside its
 * validity window, its SANs cover every requested domain, and the private
 * key actually matches the certificate. Any doubt → false (regenerate).
 * Exported for direct unit testing.
 */
export function validateLocalCertPair(
  certPem: Buffer,
  keyPem: Buffer,
  domains: string[],
  now: number = Date.now()
): boolean {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(certPem);
  } catch {
    return false;
  }

  const notBefore = new Date(cert.validFrom).getTime();
  const notAfter = new Date(cert.validTo).getTime();
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || now < notBefore || now >= notAfter) {
    return false;
  }

  // SAN coverage for every requested domain.
  const san = cert.subjectAltName || '';
  const dnsNames = new Set<string>();
  const ipNames: string[] = [];
  for (const entry of san.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.startsWith('DNS:')) {
      dnsNames.add(trimmed.slice(4).trim().toLowerCase());
    } else if (trimmed.startsWith('IP Address:')) {
      ipNames.push(trimmed.slice('IP Address:'.length).trim());
    }
  }
  for (const domain of domains) {
    if (isIpLiteral(domain)) {
      if (!ipNames.some(ip => ipEquals(ip, domain))) return false;
    } else if (!dnsNames.has(domain.toLowerCase())) {
      return false;
    }
  }

  // The private key must correspond to the certificate's public key.
  try {
    const certPub = cert.publicKey.export({ type: 'spki', format: 'der' });
    const keyPub = createPublicKey(createPrivateKey(keyPem)).export({ type: 'spki', format: 'der' });
    if (!certPub.equals(keyPub)) return false;
  } catch {
    return false;
  }

  return true;
}

/** Re-asserts restrictive modes on the TLS files (audit S-4). */
function assertTlsFileModes(certPath: string, keyPath: string): void {
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Best effort — e.g. filesystems without POSIX modes.
  }
  try {
    fs.chmodSync(certPath, 0o644);
  } catch {
    // Best effort.
  }
}

/**
 * Ensures a valid TLS certificate and key exist for local HTTPS.
 * If mkcert is available, generates or retrieves existing certs from the config/tls directory.
 * An existing pair is reused only after validation (expiry, SAN coverage,
 * key match — M-16); anything stale or mismatched is regenerated.
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

  // If both cert and key already exist, reuse them only if they validate.
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = fs.readFileSync(certPath);
      const key = fs.readFileSync(keyPath);
      if (cert.length > 0 && key.length > 0 && validateLocalCertPair(cert, key, domains)) {
        assertTlsFileModes(certPath, keyPath);
        return { certPath, keyPath, cert, key };
      }
      console.warn('[TLS] Existing certificate failed validation (expired, SAN mismatch, or key mismatch); regenerating...');
    } catch (err) {
      console.warn('[TLS] Existing certs could not be read, regenerating...', err);
    }
  }

  try {
    console.log(`[TLS] Generating TLS certificate using mkcert for: ${domains.join(', ')}...`);
    // Ensure local CA is installed (safe to call multiple times). All
    // invocations are argv spawnSync calls with no shell, so paths and
    // domain names can never be reinterpreted as shell syntax (M-16).
    const install = spawnSync('mkcert', ['-install'], { stdio: 'ignore' });
    if (install.status !== 0) {
      console.warn('[TLS] mkcert -install did not complete cleanly; continuing with generation.');
    }

    // Generate certificates using spawnSync to avoid shell injection
    const mkcertRes = spawnSync(
      'mkcert',
      ['-cert-file', certPath, '-key-file', keyPath, ...domains],
      { stdio: 'inherit' }
    );
    if (mkcertRes.status !== 0) {
      console.error('[TLS] mkcert failed with exit status', mkcertRes.status);
      return null;
    }

    try {
      fs.chmodSync(keyPath, 0o600);
    } catch {
      // Best effort chmod for systems that do not support POSIX modes
    }

    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    assertTlsFileModes(certPath, keyPath);

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
