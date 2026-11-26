#!/usr/bin/env node
import { getDefaultWatermark, loadStore, resolveAccount, saveStore } from './config.js';
import { authAttach, authLogin, authLogout, authUse } from './auth.js';
import { getDaemonHealth, slackCall, stopAllDaemons, stopDaemon } from './client.js';
import { getThreads, getUnreads, readMessages, replyMessage, searchMessages } from './slack.js';

const HELP = `slackctl — Slack CLI using your own browser session (never marks read)

Usage:
  slackctl [-a <account>] [--json] <command> [options]

Auth:
  slackctl auth login <name> [--domain <workspace>]   Open headed Chromium to sign in
  slackctl auth attach <name> --cdp <url> [--domain <workspace>]
                                                      Attach to an existing Chrome over CDP
  slackctl auth list                                  List configured accounts
  slackctl auth use <name>                            Set the default account
  slackctl auth logout <name>                         Remove an account (and its profile)

Slack:
  slackctl unreads                                    Show unread DMs, group DMs, mentions, channels
  slackctl read <target> [--limit N] [--thread TS]    Read channel (#name), DM (@user / me), or ID
  slackctl threads [--limit N]                        Show unread / recent subscribed threads
  slackctl search <query> [--limit N]                 Search messages across the workspace
  slackctl reply <target> <text> [--thread TS] [--broadcast] [--mark-read] [--watermark TEXT | --no-watermark]
                                                      Reply while preserving your read cursor
  slackctl api <method> [key=value ...]               Call any Slack Web API method directly

Config:
  slackctl config get [watermark]                     Show configuration
  slackctl config set watermark <text>                Set default reply watermark ("" to disable)

Daemon:
  slackctl daemon status                              Show running per-account daemons
  slackctl daemon stop [--all]                        Stop daemon for current (or all) accounts
`;

interface ParsedArgs {
  _: string[];
  flags: Record<string, string | boolean>;
}

const BOOL_FLAGS = new Set(['json', 'help', 'h', 'mark-read', 'broadcast', 'all', 'no-watermark']);

function parseArgs(argv: string[]): ParsedArgs {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-a' && i + 1 < argv.length) {
      flags.account = argv[++i];
    } else if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split(/=(.*)/s);
      if (v !== undefined) flags[k] = v;
      else if (BOOL_FLAGS.has(k)) flags[k] = true;
      else if (i + 1 < argv.length) flags[k] = argv[++i];
      else flags[k] = true;
    } else {
      _.push(arg);
    }
  }
  return { _, flags };
}

function need(val: string | undefined, what: string): string {
  if (!val) throw new Error(`Missing ${what}. Run \`slackctl --help\` for usage.`);
  return val;
}

function strFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function numFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = strFlag(flags, key);
  return v !== undefined ? Number(v) : undefined;
}

function formatMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const [cmd, sub, ...rest] = _;
  const asJson = Boolean(flags.json);
  const accountFlag = strFlag(flags, 'account');

  if (!cmd || flags.help || cmd === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (cmd === 'auth') {
    switch (sub) {
      case 'login': {
        const name = need(rest[0], 'account name');
        const acc = await authLogin(name, { domain: strFlag(flags, 'domain') });
        if (asJson) return console.log(JSON.stringify(acc, null, 2));
        console.log(`Signed in "${acc.name}" → ${acc.teamName} (${acc.domain}) as ${acc.userName}`);
        return;
      }
      case 'attach': {
        const name = need(rest[0], 'account name');
        const cdpUrl = need(strFlag(flags, 'cdp'), '--cdp <url>');
        const acc = await authAttach(name, cdpUrl, { domain: strFlag(flags, 'domain') });
        if (asJson) return console.log(JSON.stringify(acc, null, 2));
        console.log(
          `Attached "${acc.name}" (CDP ${cdpUrl}) → ${acc.teamName} (${acc.domain}) as ${acc.userName}`
        );
        return;
      }
      case 'list':
      case 'ls': {
        const store = loadStore();
        const list = Object.values(store.accounts);
        if (asJson) return console.log(JSON.stringify(store, null, 2));
        if (!list.length) {
          console.log('No accounts configured. Run `slackctl auth login <name>`.');
          return;
        }
        for (const a of list) {
          const def = store.defaultAccount === a.name ? '*' : ' ';
          console.log(
            `${def} ${a.name}  [${a.mode}]  ${a.teamName || a.domain} (${a.domain})  @${a.userName || a.userId || '?'}`
          );
        }
        return;
      }
      case 'use': {
        const name = need(rest[0], 'account name');
        const acc = authUse(name);
        if (asJson) return console.log(JSON.stringify(acc, null, 2));
        console.log(`Default account set to "${acc.name}" (${acc.domain})`);
        return;
      }
      case 'logout':
      case 'rm': {
        const name = need(rest[0], 'account name');
        await authLogout(name);
        console.log(`Removed account "${name}".`);
        return;
      }
      default:
        throw new Error(`Unknown auth subcommand "${sub || ''}". Run \`slackctl --help\`.`);
    }
  }

  if (cmd === 'config') {
    const store = loadStore();
    if (sub === 'get') {
      const val = getDefaultWatermark();
      if (asJson) return console.log(JSON.stringify({ watermark: val }, null, 2));
      console.log(`watermark: ${val || '(disabled)'}`);
      return;
    }
    if (sub === 'set') {
      const key = need(rest[0], 'config key (e.g. watermark)');
      if (key !== 'watermark') throw new Error(`Unknown config key "${key}". Supported: watermark`);
      const val = rest.slice(1).join(' ');
      store.watermark = val;
      saveStore(store);
      if (asJson) return console.log(JSON.stringify({ watermark: val }, null, 2));
      console.log(val ? `watermark set to "${val}"` : 'watermark disabled');
      return;
    }
    throw new Error(`Unknown config subcommand "${sub || ''}". Use get or set.`);
  }

  if (cmd === 'daemon') {
    const store = loadStore();
    switch (sub) {
      case 'status': {
        const names = accountFlag ? [resolveAccount(accountFlag).name] : Object.keys(store.accounts);
        const statuses = [];
        for (const name of names) {
          const h = await getDaemonHealth(name);
          statuses.push({ account: name, running: Boolean(h?.ok), health: h });
        }
        if (asJson) return console.log(JSON.stringify(statuses, null, 2));
        if (!statuses.length) {
          console.log('No accounts configured.');
          return;
        }
        for (const s of statuses) {
          if (s.running && s.health) {
            console.log(
              `${s.account}  running (pid ${s.health.pid}, ${s.health.mode}, ${s.health.domain}, uptime ${formatMs(s.health.uptimeMs)}, idle ${formatMs(s.health.idleMs)})`
            );
          } else {
            console.log(`${s.account}  stopped`);
          }
        }
        return;
      }
      case 'stop': {
        if (flags.all) {
          const stopped = await stopAllDaemons();
          if (asJson) return console.log(JSON.stringify({ stopped }, null, 2));
          console.log(stopped.length ? `Stopped: ${stopped.join(', ')}` : 'No running daemons.');
          return;
        }
        const acc = resolveAccount(accountFlag);
        const stopped = await stopDaemon(acc.name);
        if (asJson) return console.log(JSON.stringify({ account: acc.name, stopped }, null, 2));
        console.log(stopped ? `Stopped daemon for "${acc.name}".` : `Daemon for "${acc.name}" was not running.`);
        return;
      }
      default:
        throw new Error(`Unknown daemon subcommand "${sub || ''}". Use status or stop.`);
    }
  }

  const account = resolveAccount(accountFlag);

  switch (cmd) {
    case 'unreads': {
      const summary = await getUnreads(account);
      if (asJson) return console.log(JSON.stringify(summary, null, 2));
      console.log(`Account: ${account.name} (${account.teamName || account.domain})`);
      console.log(
        `Threads: ${summary.threads.mentions} mention(s), has_unreads=${summary.threads.hasUnreads}`
      );
      if (summary.dms.length) {
        console.log(`\nUnread DMs (${summary.dms.length}):`);
        for (const d of summary.dms) {
          console.log(`  ${d.label} (${d.id})${d.mentions ? ` — ${d.mentions} unread` : ''}`);
        }
      }
      if (summary.groupDms.length) {
        console.log(`\nUnread Group DMs (${summary.groupDms.length}):`);
        for (const g of summary.groupDms) {
          console.log(`  ${g.label} (${g.id})${g.mentions ? ` — ${g.mentions} mention(s)` : ''}`);
        }
      }
      console.log(`\nUnread Channels (${summary.channels.length}):`);
      for (const c of summary.channels.slice(0, 20)) {
        console.log(`  ${c.label} (${c.id})${c.mentions ? ` — ${c.mentions} mention(s)` : ''}`);
      }
      if (summary.channels.length > 20) {
        console.log(`  ...and ${summary.channels.length - 20} more (use --json to see all)`);
      }
      return;
    }

    case 'read': {
      const target = need(sub, 'channel, @user, me, or ID');
      const data = await readMessages(account, target, {
        limit: numFlag(flags, 'limit'),
        threadTs: strFlag(flags, 'thread'),
      });
      if (asJson) return console.log(JSON.stringify(data, null, 2));
      console.log(`${data.label} (${data.channelId}) — ${data.messages.length} message(s):`);
      for (const m of data.messages) {
        const replies = m.replyCount ? ` [${m.replyCount} replies, ts=${m.ts}]` : ` [ts=${m.ts}]`;
        console.log(`\n[${m.time}] ${m.user}${replies}\n${m.text || '(no text)'}`);
      }
      return;
    }

    case 'threads': {
      const threads = await getThreads(account, numFlag(flags, 'limit') ?? 10);
      if (asJson) return console.log(JSON.stringify(threads, null, 2));
      if (!threads.length) {
        console.log('No threads found.');
        return;
      }
      for (const t of threads) {
        console.log(
          `${t.channelLabel} (${t.channelId}) ts=${t.threadTs} [${t.unreadReplies} unread] ${t.rootUser}: ${t.rootText}`
        );
      }
      return;
    }

    case 'search': {
      const query = need([sub, ...rest].filter(Boolean).join(' '), 'search query');
      const matches = await searchMessages(account, query, numFlag(flags, 'limit') ?? 15);
      if (asJson) return console.log(JSON.stringify(matches, null, 2));
      if (!matches.length) {
        console.log('No matches.');
        return;
      }
      for (const m of matches) {
        console.log(`#${m.channelName} (${m.channelId}) ts=${m.ts} ${m.user}: ${m.text.slice(0, 180)}`);
      }
      return;
    }

    case 'reply': {
      const target = need(sub, 'channel, @user, me, or ID');
      const text = need(rest.join(' '), 'message text');
      const res = await replyMessage(account, target, text, {
        threadTs: strFlag(flags, 'thread'),
        broadcast: Boolean(flags.broadcast),
        markRead: Boolean(flags['mark-read']),
        watermark: flags['no-watermark'] ? false : strFlag(flags, 'watermark'),
      });
      if (asJson) return console.log(JSON.stringify(res, null, 2));
      console.log(
        `Sent to ${res.channelId} (ts=${res.ts})${
          flags['mark-read']
            ? ''
            : res.restored
              ? ` · read cursor preserved (${res.preservedLastRead})`
              : ' · no prior read cursor'
        }`
      );
      return;
    }

    case 'api': {
      const method = need(sub, 'Slack API method (e.g. auth.test)');
      const params: Record<string, string> = {};
      for (const kv of rest) {
        const eq = kv.indexOf('=');
        if (eq === -1) throw new Error(`Expected key=value, got "${kv}"`);
        params[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
      const res = await slackCall(account.name, method, params);
      console.log(JSON.stringify(res, null, 2));
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}". Run \`slackctl --help\`.`);
  }
}

main().catch((err) => {
  console.error(`slackctl: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
