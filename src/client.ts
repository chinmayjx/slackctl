import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, ensureDir, loadStore, logPath, socketPath } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface DaemonHealth {
  ok: boolean;
  account: string;
  mode: string;
  domain: string;
  pid: number;
  uptimeMs: number;
  idleMs: number;
  idleTimeoutMs: number;
}

function unixRequest<T>(
  sock: string,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: unknown,
  timeoutMs = 30_000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath: sock,
        path: urlPath,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text) as T;
            if ((res.statusCode || 500) >= 400) {
              const errMsg = (parsed as { error?: string })?.error || text;
              reject(new Error(`Daemon HTTP ${res.statusCode}: ${errMsg}`));
            } else {
              resolve(parsed);
            }
          } catch {
            reject(new Error(`Invalid JSON from daemon: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Daemon request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function getDaemonHealth(accountName: string): Promise<DaemonHealth | null> {
  const sock = socketPath(accountName);
  if (!fs.existsSync(sock)) return null;
  try {
    return await unixRequest<DaemonHealth>(sock, 'GET', '/health', undefined, 2000);
  } catch {
    return null;
  }
}

export async function ensureDaemon(accountName: string): Promise<DaemonHealth> {
  const existing = await getDaemonHealth(accountName);
  if (existing?.ok) return existing;

  ensureDir(STATE_DIR);
  const sock = socketPath(accountName);
  if (fs.existsSync(sock)) {
    try {
      fs.unlinkSync(sock);
    } catch {
      // ignore
    }
  }

  const daemonScript = path.join(__dirname, 'daemon.js');
  const logFile = logPath(accountName);
  const logFd = fs.openSync(logFile, 'w', 0o600);

  const child = spawn(process.execPath, [daemonScript, accountName], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    const health = await getDaemonHealth(accountName);
    if (health?.ok) return health;
    // Check if child exited early
    try {
      process.kill(child.pid!, 0);
    } catch {
      const logTail = fs.existsSync(logFile)
        ? fs.readFileSync(logFile, 'utf8').trim().slice(-600)
        : '';
      throw new Error(
        `Daemon for "${accountName}" exited during startup.${logTail ? `\n${logTail}` : ''}`
      );
    }
  }
  throw new Error(`Timed out waiting for daemon "${accountName}" to start. See ${logFile}`);
}

export async function slackCall<T = Record<string, unknown>>(
  accountName: string,
  method: string,
  params: Record<string, string | number | boolean | undefined> = {}
): Promise<T & { ok: boolean; error?: string }> {
  await ensureDaemon(accountName);
  const sock = socketPath(accountName);
  return unixRequest<T & { ok: boolean; error?: string }>(sock, 'POST', '/api', {
    method,
    params,
  });
}

export async function stopDaemon(accountName: string): Promise<boolean> {
  const sock = socketPath(accountName);
  const health = await getDaemonHealth(accountName);
  if (!health) {
    if (fs.existsSync(sock)) {
      try {
        fs.unlinkSync(sock);
      } catch {
        // ignore
      }
    }
    return false;
  }
  try {
    await unixRequest(sock, 'POST', '/shutdown', undefined, 5000);
  } catch {
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }
  return true;
}

export async function stopAllDaemons(): Promise<string[]> {
  const store = loadStore();
  const stopped: string[] = [];
  for (const name of Object.keys(store.accounts)) {
    if (await stopDaemon(name)) stopped.push(name);
  }
  return stopped;
}
