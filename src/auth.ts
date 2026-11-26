import fs from 'node:fs';
import { chromium, type Page } from 'playwright';
import {
  ensureDir,
  loadStore,
  profileDir,
  resolveExecutablePath,
  saveStore,
  validateAccountName,
  type AccountConfig,
} from './config.js';
import { stopDaemon } from './client.js';

interface ExtractedTeam {
  token: string;
  domain: string;
  name?: string;
  id?: string;
}

async function extractTeamsFromPage(page: Page): Promise<ExtractedTeam[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('localConfig_v2');
    if (!raw) return [];
    const cfg = JSON.parse(raw) as {
      teams?: Record<string, { token?: string; domain?: string; name?: string; id?: string }>;
    };
    return Object.values(cfg.teams || {})
      .filter((t) => Boolean(t.token && t.domain))
      .map((t) => ({ token: t.token!, domain: t.domain!, name: t.name, id: t.id }));
  });
}

async function verifyTeam(
  page: Page,
  team: ExtractedTeam
): Promise<{ userId: string; userName: string; teamId: string; teamName: string }> {
  await page.goto(`https://${team.domain}.slack.com/robots.txt`, { waitUntil: 'domcontentloaded' });
  const auth = (await page.evaluate(async (token: string) => {
    const fd = new FormData();
    fd.append('token', token);
    const res = await fetch('/api/auth.test', {
      method: 'POST',
      body: fd,
      credentials: 'include',
    });
    return res.json();
  }, team.token)) as {
    ok?: boolean;
    error?: string;
    user_id?: string;
    user?: string;
    team_id?: string;
    team?: string;
  };
  if (!auth.ok) {
    throw new Error(`Slack auth.test failed for ${team.domain}: ${auth.error || 'unknown error'}`);
  }
  return {
    userId: auth.user_id || '',
    userName: auth.user || '',
    teamId: auth.team_id || team.id || '',
    teamName: auth.team || team.name || team.domain,
  };
}

export async function authLogin(
  rawName: string,
  opts: { domain?: string; timeoutSec?: number } = {}
): Promise<AccountConfig> {
  const name = validateAccountName(rawName);
  await stopDaemon(name);

  const dir = profileDir(name);
  ensureDir(dir);

  const startUrl = opts.domain
    ? `https://${opts.domain}.slack.com`
    : 'https://slack.com/signin#/signin';

  console.error(`Opening headed Chromium for account "${name}" (${startUrl})...`);
  console.error('Complete sign-in in the browser window. Waiting up to 5 minutes...');

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    executablePath: resolveExecutablePath(),
    viewport: { width: 1280, height: 860 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + (opts.timeoutSec ?? 300) * 1000;
    let found: ExtractedTeam | null = null;

    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        if (p.isClosed()) continue;
        if (!/^https:\/\/[^/]*slack\.com\//.test(p.url())) continue;
        try {
          const teams = await extractTeamsFromPage(p);
          if (teams.length > 0) {
            found = opts.domain
              ? teams.find((t) =>
                  t.domain.toLowerCase().includes(opts.domain!.toLowerCase())
                ) || teams[0]
              : teams[0];
            break;
          }
        } catch {
          // page navigating
        }
      }
      if (found) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!found) {
      throw new Error('Timed out waiting for Slack sign-in.');
    }

    const verifyPage = await context.newPage();
    const info = await verifyTeam(verifyPage, found);
    await verifyPage.close();

    const account: AccountConfig = {
      name,
      mode: 'profile',
      domain: found.domain,
      teamId: info.teamId,
      teamName: info.teamName,
      userId: info.userId,
      userName: info.userName,
      createdAt: new Date().toISOString(),
    };

    const store = loadStore();
    store.accounts[name] = account;
    if (!store.defaultAccount) store.defaultAccount = name;
    saveStore(store);
    return account;
  } finally {
    await context.close();
  }
}

export async function authAttach(
  rawName: string,
  cdpUrl: string,
  opts: { domain?: string } = {}
): Promise<AccountConfig> {
  const name = validateAccountName(rawName);
  await stopDaemon(name);

  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) {
    await browser.close();
    throw new Error(`No browser context available at ${cdpUrl}`);
  }
  const page = await ctx.newPage();
  try {
    await page.goto('https://app.slack.com/robots.txt', { waitUntil: 'domcontentloaded' });
    const teams = await extractTeamsFromPage(page);
    if (!teams.length) {
      throw new Error(`No signed-in Slack workspaces found in browser at ${cdpUrl}`);
    }
    const chosen = opts.domain
      ? teams.find((t) => t.domain.toLowerCase().includes(opts.domain!.toLowerCase()))
      : teams[0];
    if (!chosen) {
      throw new Error(
        `No workspace matching "${opts.domain}". Found: ${teams.map((t) => t.domain).join(', ')}`
      );
    }

    const info = await verifyTeam(page, chosen);
    const account: AccountConfig = {
      name,
      mode: 'cdp',
      cdpUrl,
      domain: chosen.domain,
      teamId: info.teamId,
      teamName: info.teamName,
      userId: info.userId,
      userName: info.userName,
      createdAt: new Date().toISOString(),
    };

    const store = loadStore();
    store.accounts[name] = account;
    if (!store.defaultAccount) store.defaultAccount = name;
    saveStore(store);
    return account;
  } finally {
    await page.close();
    await browser.close();
  }
}

export function authUse(rawName: string): AccountConfig {
  const name = validateAccountName(rawName);
  const store = loadStore();
  const acc = store.accounts[name];
  if (!acc) throw new Error(`Unknown account "${name}".`);
  store.defaultAccount = name;
  saveStore(store);
  return acc;
}

export async function authLogout(rawName: string): Promise<void> {
  const name = validateAccountName(rawName);
  await stopDaemon(name);
  const store = loadStore();
  const acc = store.accounts[name];
  if (!acc) throw new Error(`Unknown account "${name}".`);
  delete store.accounts[name];
  if (store.defaultAccount === name) {
    store.defaultAccount = Object.keys(store.accounts)[0];
  }
  saveStore(store);
  if (acc.mode === 'profile') {
    const dir = profileDir(name);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
