#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  IDLE_TIMEOUT_MS,
  STATE_DIR,
  ensureDir,
  profileDir,
  resolveAccount,
  resolveExecutablePath,
  socketPath,
  type AccountConfig,
} from './config.js';

interface SlackTeamSession {
  token: string;
  domain: string;
  name?: string;
}

class SlackDaemon {
  private account: AccountConfig;
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private token = '';
  private domain = '';
  private startedAt = Date.now();
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private server: http.Server | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private shuttingDown = false;

  constructor(account: AccountConfig) {
    this.account = account;
    this.domain = account.domain;
  }

  private resetIdleTimer(): void {
    this.lastActivity = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (IDLE_TIMEOUT_MS > 0) {
      this.idleTimer = setTimeout(() => {
        console.error(`[slackctl-daemon:${this.account.name}] idle timeout reached, shutting down`);
        void this.shutdown(0);
      }, IDLE_TIMEOUT_MS);
    }
  }

  private async loadTokenFromPage(page: Page): Promise<SlackTeamSession> {
    await page.goto('https://app.slack.com/robots.txt', { waitUntil: 'domcontentloaded' });
    const targetDomain = this.account.domain;
    const found = await page.evaluate((wantedDomain: string) => {
      const raw = localStorage.getItem('localConfig_v2');
      if (!raw) return null;
      const cfg = JSON.parse(raw) as {
        teams?: Record<string, { token?: string; domain?: string; name?: string }>;
      };
      const teams = Object.values(cfg.teams || {}).filter((t) => t.token && t.domain);
      if (!teams.length) return null;
      const match = wantedDomain
        ? teams.find((t) => t.domain?.toLowerCase() === wantedDomain.toLowerCase()) ||
          teams.find((t) => t.domain?.toLowerCase().includes(wantedDomain.toLowerCase()))
        : teams[0];
      return match ? { token: match.token!, domain: match.domain!, name: match.name } : null;
    }, targetDomain);

    if (!found) {
      throw new Error(
        `Not signed in to Slack workspace "${targetDomain || '(any)'}". Run \`slackctl auth login ${this.account.name}\`.`
      );
    }
    this.token = found.token;
    this.domain = found.domain;
    await page.goto(`https://${this.domain}.slack.com/robots.txt`, {
      waitUntil: 'domcontentloaded',
    });
    return found;
  }

  private async initBrowser(): Promise<void> {
    if (this.account.mode === 'cdp') {
      if (!this.account.cdpUrl) {
        throw new Error(`Account "${this.account.name}" is in CDP mode but missing cdpUrl.`);
      }
      this.browser = await chromium.connectOverCDP(this.account.cdpUrl);
      const ctx = this.browser.contexts()[0];
      if (!ctx) throw new Error('No browser context found in CDP browser.');
      this.context = ctx;
      this.page = await ctx.newPage();
    } else {
      const dir = profileDir(this.account.name);
      ensureDir(dir);
      this.context = await chromium.launchPersistentContext(dir, {
        headless: true,
        executablePath: resolveExecutablePath(),
        args: ['--disable-blink-features=AutomationControlled'],
      });
      this.page = this.context.pages()[0] || (await this.context.newPage());
    }
    await this.loadTokenFromPage(this.page);
  }

  private async executeApi(
    method: string,
    params: Record<string, string | number | boolean | undefined>
  ): Promise<unknown> {
    if (!this.page || this.page.isClosed()) {
      await this.initBrowser();
    }
    const page = this.page!;
    const runFetch = async () =>
      page.evaluate(
        async ({
          method,
          params,
          token,
        }: {
          method: string;
          params: Record<string, string | number | boolean | undefined>;
          token: string;
        }) => {
          const fd = new FormData();
          fd.append('token', token);
          for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null) fd.append(k, String(v));
          }
          const res = await fetch(`/api/${method}`, {
            method: 'POST',
            body: fd,
            credentials: 'include',
          });
          return res.json();
        },
        { method, params, token: this.token }
      );

    let data = (await runFetch()) as { ok?: boolean; error?: string };
    if (data && data.ok === false && (data.error === 'invalid_auth' || data.error === 'token_revoked')) {
      await this.loadTokenFromPage(page);
      data = (await runFetch()) as { ok?: boolean; error?: string };
    }
    return data;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async start(): Promise<void> {
    ensureDir(STATE_DIR);
    const sock = socketPath(this.account.name);
    if (fs.existsSync(sock)) {
      fs.unlinkSync(sock);
    }

    await this.initBrowser();
    this.resetIdleTimer();

    this.server = http.createServer((req, res) => {
      this.resetIdleTimer();
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'GET' && req.url === '/health') {
        return send(200, {
          ok: true,
          account: this.account.name,
          mode: this.account.mode,
          domain: this.domain,
          pid: process.pid,
          uptimeMs: Date.now() - this.startedAt,
          idleMs: Date.now() - this.lastActivity,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
        });
      }

      if (req.method === 'POST' && req.url === '/shutdown') {
        send(200, { ok: true });
        setTimeout(() => void this.shutdown(0), 25);
        return;
      }

      if (req.method === 'POST' && req.url === '/api') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          void (async () => {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
                method?: string;
                params?: Record<string, string | number | boolean | undefined>;
              };
              if (!payload.method) {
                return send(400, { ok: false, error: 'missing method' });
              }
              const result = await this.enqueue(() =>
                this.executeApi(payload.method!, payload.params || {})
              );
              send(200, result);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              send(500, { ok: false, error: msg });
            }
          })();
        });
        return;
      }

      send(404, { ok: false, error: 'not_found' });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(sock, () => {
        try {
          fs.chmodSync(sock, 0o600);
        } catch {
          // ignore chmod error
        }
        resolve();
      });
    });

    console.error(
      `[slackctl-daemon:${this.account.name}] ready on ${sock} (pid ${process.pid}, domain ${this.domain})`
    );
  }

  async shutdown(code: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      if (this.server) {
        await new Promise<void>((r) => this.server!.close(() => r()));
      }
    } catch {
      // ignore
    }
    try {
      if (this.account.mode === 'cdp') {
        if (this.page && !this.page.isClosed()) await this.page.close();
        if (this.browser) await this.browser.close();
      } else if (this.context) {
        await this.context.close();
      }
    } catch {
      // ignore
    }
    try {
      const sock = socketPath(this.account.name);
      if (fs.existsSync(sock)) fs.unlinkSync(sock);
    } catch {
      // ignore
    }
    process.exit(code);
  }
}

async function main() {
  const accountName = process.argv[2];
  if (!accountName) {
    console.error('Usage: daemon.js <account>');
    process.exit(1);
  }
  const account = resolveAccount(accountName);
  const daemon = new SlackDaemon(account);
  process.on('SIGTERM', () => void daemon.shutdown(0));
  process.on('SIGINT', () => void daemon.shutdown(0));
  await daemon.start();
}

main().catch((err) => {
  console.error(`[slackctl-daemon] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
