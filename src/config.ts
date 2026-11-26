import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AccountConfig {
  name: string;
  mode: 'profile' | 'cdp';
  cdpUrl?: string;
  domain: string;
  teamId?: string;
  teamName?: string;
  userId?: string;
  userName?: string;
  createdAt: string;
}

export interface AccountsStore {
  defaultAccount?: string;
  watermark?: string;
  accounts: Record<string, AccountConfig>;
}

export const DEFAULT_WATERMARK = 'Sent via AI';

const home = os.homedir();

export const CONFIG_DIR =
  process.env.SLACKCTL_CONFIG_DIR ||
  path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'slackctl');

export const DATA_DIR =
  process.env.SLACKCTL_DATA_DIR ||
  path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'slackctl');

export const STATE_DIR =
  process.env.SLACKCTL_STATE_DIR ||
  path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'slackctl');

export const CACHE_DIR =
  process.env.SLACKCTL_CACHE_DIR ||
  path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'slackctl');

export const IDLE_TIMEOUT_MS = Number(process.env.SLACKCTL_IDLE_MS || 15 * 60 * 1000);

export function resolveExecutablePath(): string | undefined {
  if (process.env.SLACKCTL_CHROME_PATH) return process.env.SLACKCTL_CHROME_PATH;
  // Prefer system Chrome/Chromium if Playwright's exact revision isn't installed.
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function validateAccountName(name: string): string {
  const clean = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(clean)) {
    throw new Error(
      `Invalid account name "${name}". Use 1-32 lowercase letters, digits, hyphens, or underscores.`
    );
  }
  return clean;
}

export function accountsFile(): string {
  return path.join(CONFIG_DIR, 'accounts.json');
}

export function profileDir(account: string): string {
  return path.join(DATA_DIR, 'profiles', account);
}

export function socketPath(account: string): string {
  return path.join(STATE_DIR, `${account}.sock`);
}

export function logPath(account: string): string {
  return path.join(STATE_DIR, `${account}.log`);
}

export function cachePath(account: string): string {
  return path.join(CACHE_DIR, `${account}-names.json`);
}

export function loadStore(): AccountsStore {
  const file = accountsFile();
  if (!fs.existsSync(file)) {
    return { accounts: {} };
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AccountsStore;
  return {
    defaultAccount: parsed.defaultAccount,
    watermark: parsed.watermark,
    accounts: parsed.accounts || {},
  };
}

export function getDefaultWatermark(): string {
  if (process.env.SLACKCTL_WATERMARK !== undefined) {
    return process.env.SLACKCTL_WATERMARK;
  }
  const store = loadStore();
  return store.watermark !== undefined ? store.watermark : DEFAULT_WATERMARK;
}

export function saveStore(store: AccountsStore): void {
  ensureDir(CONFIG_DIR);
  const file = accountsFile();
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

export function resolveAccount(requested?: string): AccountConfig {
  const store = loadStore();
  const name = requested ? validateAccountName(requested) : store.defaultAccount;
  if (!name) {
    const names = Object.keys(store.accounts);
    if (names.length === 1) return store.accounts[names[0]];
    throw new Error(
      'No Slack account configured. Run `slackctl auth login <name>` or `slackctl auth attach <name> --cdp <url>`.'
    );
  }
  const acc = store.accounts[name];
  if (!acc) {
    const known = Object.keys(store.accounts);
    throw new Error(
      `Unknown account "${name}".${known.length ? ` Configured: ${known.join(', ')}` : ''}`
    );
  }
  return acc;
}
