// Environment helpers for the npm entry scripts (dev, start, seed, e2e).
// Same rules as server/config.ts: KEY=VALUE lines in .env, `#` comments, and
// a variable set in the real environment always wins over .env.
import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');

export function readDotEnv(file = resolve(ROOT, '.env')): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/** The shell value, else the .env value; empty counts as unset. */
export function envValue(name: string, dotenv: Record<string, string> = readDotEnv()): string | undefined {
  const shell = process.env[name];
  if (shell !== undefined && shell !== '') return shell;
  const file = dotenv[name];
  return file !== undefined && file !== '' ? file : undefined;
}

export const isOff = (v: string | undefined) => v !== undefined && (v === '0' || v.toLowerCase() === 'false');
export const isOn = (v: string | undefined) => v !== undefined && (v === '1' || v.toLowerCase() === 'true');

const VIRTUAL = /vethernet|virtualbox|vbox|vmware|wsl|hyper-v|docker|loopback|bluetooth|tailscale|zerotier|utun|br-|veth/i;

/**
 * IPv4 addresses a phone on the same network could use, best guess first:
 * physical adapters before virtual ones, then 192.168.x, 10.x, 172.16-31.x.
 */
export function lanAddresses(): Array<{ name: string; address: string }> {
  const found: Array<{ name: string; address: string; score: number }> = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || i.address.startsWith('169.254.')) continue;
      const range = i.address.startsWith('192.168.') ? 0
        : i.address.startsWith('10.') ? 1
          : /^172\.(1[6-9]|2\d|3[01])\./.test(i.address) ? 2 : 3;
      found.push({ name, address: i.address, score: (VIRTUAL.test(name) ? 10 : 0) + range });
    }
  }
  return found.sort((a, b) => a.score - b.score).map(({ name, address }) => ({ name, address }));
}

/** True when a phone could never open this URL (localhost, 127.x, ::1, 0.0.0.0). */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
  } catch {
    return false;
  }
}
