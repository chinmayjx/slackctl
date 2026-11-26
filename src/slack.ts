import fs from 'node:fs';
import { CACHE_DIR, cachePath, ensureDir, getDefaultWatermark, type AccountConfig } from './config.js';
import { slackCall } from './client.js';

interface NameCache {
  updatedAt: number;
  users: Record<string, string>;
  channels: Record<string, { name: string; isIm?: boolean; isMpim?: boolean; userId?: string }>;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function loadNameCache(account: string): NameCache {
  const file = cachePath(account);
  if (!fs.existsSync(file)) return { updatedAt: Date.now(), users: {}, channels: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as NameCache;
    if (Date.now() - (parsed.updatedAt || 0) > CACHE_TTL_MS) {
      return { updatedAt: Date.now(), users: {}, channels: {} };
    }
    return {
      updatedAt: parsed.updatedAt || Date.now(),
      users: parsed.users || {},
      channels: parsed.channels || {},
    };
  } catch {
    return { updatedAt: Date.now(), users: {}, channels: {} };
  }
}

function saveNameCache(account: string, cache: NameCache): void {
  ensureDir(CACHE_DIR);
  fs.writeFileSync(cachePath(account), JSON.stringify(cache, null, 2), { mode: 0o600 });
}

export async function resolveUserName(
  account: string,
  userId: string,
  cache: NameCache
): Promise<string> {
  if (!userId) return 'unknown';
  if (cache.users[userId]) return cache.users[userId];
  const res = await slackCall<{
    user?: {
      name?: string;
      real_name?: string;
      profile?: { display_name?: string; real_name?: string };
    };
  }>(account, 'users.info', { user: userId });
  if (res.ok && res.user) {
    const label =
      res.user.profile?.display_name ||
      res.user.profile?.real_name ||
      res.user.real_name ||
      res.user.name ||
      userId;
    cache.users[userId] = label;
    return label;
  }
  return userId;
}

export async function resolveChannelLabel(
  account: string,
  channelId: string,
  cache: NameCache
): Promise<string> {
  const cached = cache.channels[channelId];
  if (cached) {
    if (cached.isIm && cached.userId) {
      return `@${await resolveUserName(account, cached.userId, cache)}`;
    }
    return cached.isMpim ? cached.name : `#${cached.name}`;
  }
  const res = await slackCall<{
    channel?: {
      id: string;
      name?: string;
      is_im?: boolean;
      is_mpim?: boolean;
      user?: string;
    };
  }>(account, 'conversations.info', { channel: channelId });
  if (res.ok && res.channel) {
    const ch = res.channel;
    cache.channels[channelId] = {
      name: ch.name || channelId,
      isIm: ch.is_im,
      isMpim: ch.is_mpim,
      userId: ch.user,
    };
    if (ch.is_im && ch.user) {
      return `@${await resolveUserName(account, ch.user, cache)}`;
    }
    return ch.is_mpim ? ch.name || channelId : `#${ch.name || channelId}`;
  }
  return channelId;
}

export async function resolveTargetChannel(
  account: AccountConfig,
  target: string
): Promise<string> {
  const trimmed = target.trim();
  if (/^[CDG][A-Z0-9]{7,}$/.test(trimmed)) return trimmed;

  if (trimmed === 'me' || trimmed === 'self' || trimmed === '@me') {
    let userId = account.userId;
    if (!userId) {
      const auth = await slackCall<{ user_id?: string }>(account.name, 'auth.test');
      if (!auth.ok || !auth.user_id) throw new Error(`auth.test failed: ${auth.error}`);
      userId = auth.user_id;
    }
    const open = await slackCall<{ channel?: { id: string } }>(account.name, 'conversations.open', {
      users: userId,
    });
    if (!open.ok || !open.channel?.id) {
      throw new Error(`Could not open self-DM: ${open.error || 'unknown error'}`);
    }
    return open.channel.id;
  }

  if (trimmed.startsWith('@') || /^U[A-Z0-9]{7,}$/.test(trimmed)) {
    let userId = /^U[A-Z0-9]{7,}$/.test(trimmed) ? trimmed : '';
    if (!userId) {
      const handle = trimmed.slice(1).toLowerCase();
      // Search users.list (paginated up to 1000) or users.lookupByEmail if email
      if (handle.includes('@')) {
        const res = await slackCall<{ user?: { id: string } }>(
          account.name,
          'users.lookupByEmail',
          { email: handle }
        );
        if (res.ok && res.user?.id) userId = res.user.id;
      }
      if (!userId) {
        let cursor = '';
        for (let page = 0; page < 5; page++) {
          const res = await slackCall<{
            members?: Array<{
              id: string;
              name?: string;
              real_name?: string;
              profile?: { display_name?: string; real_name?: string };
            }>;
            response_metadata?: { next_cursor?: string };
          }>(account.name, 'users.list', { limit: 200, cursor: cursor || undefined });
          if (!res.ok) break;
          const match = (res.members || []).find((m) => {
            const fields = [
              m.name,
              m.real_name,
              m.profile?.display_name,
              m.profile?.real_name,
            ]
              .filter(Boolean)
              .map((s) => s!.toLowerCase());
            return fields.includes(handle) || fields.some((f) => f.includes(handle));
          });
          if (match) {
            userId = match.id;
            break;
          }
          cursor = res.response_metadata?.next_cursor || '';
          if (!cursor) break;
        }
      }
    }
    if (!userId) throw new Error(`Could not find user "${target}".`);
    const open = await slackCall<{ channel?: { id: string } }>(account.name, 'conversations.open', {
      users: userId,
    });
    if (!open.ok || !open.channel?.id) {
      throw new Error(`Could not open DM with ${target}: ${open.error || 'unknown error'}`);
    }
    return open.channel.id;
  }

  // Channel name (#general or general)
  const wanted = trimmed.replace(/^#/, '').toLowerCase();
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const res = await slackCall<{
      channels?: Array<{ id: string; name?: string }>;
      response_metadata?: { next_cursor?: string };
    }>(account.name, 'users.conversations', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor: cursor || undefined,
    });
    if (!res.ok) break;
    const match = (res.channels || []).find((c) => c.name?.toLowerCase() === wanted);
    if (match) return match.id;
    cursor = res.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  throw new Error(`Could not find channel "${target}". You can also pass a channel ID (e.g. C0...).`);
}

export interface UnreadItem {
  id: string;
  label: string;
  kind: 'dm' | 'group_dm' | 'channel';
  mentions: number;
  hasUnreads: boolean;
  lastRead?: string;
}

export interface UnreadsSummary {
  dms: UnreadItem[];
  groupDms: UnreadItem[];
  channels: UnreadItem[];
  threads: { hasUnreads: boolean; mentions: number };
}

export async function getUnreads(account: AccountConfig): Promise<UnreadsSummary> {
  const res = await slackCall<{
    channels?: Array<{ id: string; has_unreads?: boolean; mention_count?: number; last_read?: string }>;
    ims?: Array<{ id: string; has_unreads?: boolean; dm_count?: number; mention_count?: number; last_read?: string }>;
    mpims?: Array<{ id: string; has_unreads?: boolean; mention_count?: number; last_read?: string }>;
    threads?: { has_unreads?: boolean; mention_count?: number };
  }>(account.name, 'client.counts');

  if (!res.ok) {
    throw new Error(`client.counts failed: ${res.error || 'unknown error'}`);
  }

  const cache = loadNameCache(account.name);

  const rawDms = (res.ims || []).filter((x) => x.has_unreads || (x.dm_count || 0) > 0);
  const rawMpims = (res.mpims || []).filter((x) => x.has_unreads || (x.mention_count || 0) > 0);
  const rawChannels = (res.channels || []).filter(
    (x) => x.has_unreads || (x.mention_count || 0) > 0
  );

  const dms: UnreadItem[] = [];
  for (const x of rawDms) {
    dms.push({
      id: x.id,
      label: await resolveChannelLabel(account.name, x.id, cache),
      kind: 'dm',
      mentions: x.dm_count || x.mention_count || 0,
      hasUnreads: Boolean(x.has_unreads || (x.dm_count || 0) > 0),
      lastRead: x.last_read,
    });
  }

  const groupDms: UnreadItem[] = [];
  for (const x of rawMpims) {
    groupDms.push({
      id: x.id,
      label: await resolveChannelLabel(account.name, x.id, cache),
      kind: 'group_dm',
      mentions: x.mention_count || 0,
      hasUnreads: Boolean(x.has_unreads),
      lastRead: x.last_read,
    });
  }

  // Sort channels with mentions first, then resolve up to 30 channel names to keep it fast.
  rawChannels.sort((a, b) => (b.mention_count || 0) - (a.mention_count || 0));
  const channels: UnreadItem[] = [];
  for (const x of rawChannels.slice(0, 30)) {
    channels.push({
      id: x.id,
      label: await resolveChannelLabel(account.name, x.id, cache),
      kind: 'channel',
      mentions: x.mention_count || 0,
      hasUnreads: Boolean(x.has_unreads),
      lastRead: x.last_read,
    });
  }
  for (const x of rawChannels.slice(30)) {
    channels.push({
      id: x.id,
      label: x.id,
      kind: 'channel',
      mentions: x.mention_count || 0,
      hasUnreads: Boolean(x.has_unreads),
      lastRead: x.last_read,
    });
  }

  saveNameCache(account.name, cache);
  return {
    dms,
    groupDms,
    channels,
    threads: {
      hasUnreads: Boolean(res.threads?.has_unreads),
      mentions: res.threads?.mention_count || 0,
    },
  };
}

export interface FormattedMessage {
  ts: string;
  time: string;
  user: string;
  userId: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
}

export async function readMessages(
  account: AccountConfig,
  target: string,
  opts: { limit?: number; threadTs?: string } = {}
): Promise<{ channelId: string; label: string; messages: FormattedMessage[] }> {
  const channelId = await resolveTargetChannel(account, target);
  const limit = opts.limit ?? 20;
  const method = opts.threadTs ? 'conversations.replies' : 'conversations.history';
  const params: Record<string, string | number | undefined> = {
    channel: channelId,
    limit,
    ts: opts.threadTs,
  };
  const res = await slackCall<{
    messages?: Array<{
      ts: string;
      user?: string;
      bot_id?: string;
      username?: string;
      text?: string;
      thread_ts?: string;
      reply_count?: number;
    }>;
  }>(account.name, method, params);

  if (!res.ok) {
    throw new Error(`${method} failed for ${channelId}: ${res.error || 'unknown error'}`);
  }

  const cache = loadNameCache(account.name);
  const label = await resolveChannelLabel(account.name, channelId, cache);
  const raw = opts.threadTs ? res.messages || [] : [...(res.messages || [])].reverse();

  const messages: FormattedMessage[] = [];
  for (const m of raw) {
    const userId = m.user || m.bot_id || '';
    const user = m.user
      ? await resolveUserName(account.name, m.user, cache)
      : m.username || m.bot_id || 'bot';
    const ms = Math.floor(parseFloat(m.ts) * 1000);
    const time = Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z' : m.ts;
    messages.push({
      ts: m.ts,
      time,
      user,
      userId,
      text: (m.text || '').trim(),
      threadTs: m.thread_ts,
      replyCount: m.reply_count,
    });
  }

  saveNameCache(account.name, cache);
  return { channelId, label, messages };
}

export async function getThreads(
  account: AccountConfig,
  limit = 10
): Promise<
  Array<{
    channelId: string;
    channelLabel: string;
    threadTs: string;
    unreadReplies: number;
    rootUser: string;
    rootText: string;
  }>
> {
  const res = await slackCall<{
    threads?: Array<{
      root_msg?: {
        channel?: string;
        ts?: string;
        user?: string;
        text?: string;
      };
      unread_replies?: unknown[];
    }>;
  }>(account.name, 'subscriptions.thread.getView', { limit });

  if (!res.ok) {
    throw new Error(`subscriptions.thread.getView failed: ${res.error || 'unknown error'}`);
  }

  const cache = loadNameCache(account.name);
  const out = [];
  for (const t of res.threads || []) {
    const root = t.root_msg || {};
    const channelId = root.channel || '';
    const channelLabel = channelId ? await resolveChannelLabel(account.name, channelId, cache) : '';
    const rootUser = root.user ? await resolveUserName(account.name, root.user, cache) : 'unknown';
    out.push({
      channelId,
      channelLabel,
      threadTs: root.ts || '',
      unreadReplies: (t.unread_replies || []).length,
      rootUser,
      rootText: (root.text || '').trim().slice(0, 140),
    });
  }
  saveNameCache(account.name, cache);
  return out;
}

export async function searchMessages(
  account: AccountConfig,
  query: string,
  limit = 15
): Promise<
  Array<{
    channelId: string;
    channelName: string;
    ts: string;
    user: string;
    text: string;
    permalink?: string;
  }>
> {
  const res = await slackCall<{
    messages?: {
      matches?: Array<{
        ts?: string;
        username?: string;
        text?: string;
        permalink?: string;
        channel?: { id?: string; name?: string };
      }>;
    };
  }>(account.name, 'search.messages', {
    query,
    count: limit,
    sort: 'timestamp',
    sort_dir: 'desc',
  });
  if (!res.ok) {
    throw new Error(`search.messages failed: ${res.error || 'unknown error'}`);
  }
  return (res.messages?.matches || []).map((m) => ({
    channelId: m.channel?.id || '',
    channelName: m.channel?.name || m.channel?.id || '',
    ts: m.ts || '',
    user: m.username || 'unknown',
    text: (m.text || '').trim(),
    permalink: m.permalink,
  }));
}

export async function replyMessage(
  account: AccountConfig,
  target: string,
  text: string,
  opts: { threadTs?: string; broadcast?: boolean; markRead?: boolean; watermark?: string | false } = {}
): Promise<{
  ok: boolean;
  channelId: string;
  ts: string;
  threadTs?: string;
  preservedLastRead?: string;
  restored: boolean;
  watermark?: string;
}> {
  const channelId = await resolveTargetChannel(account, target);

  let beforeLastRead: string | undefined;
  if (!opts.markRead) {
    const info = await slackCall<{ channel?: { last_read?: string } }>(
      account.name,
      'conversations.info',
      { channel: channelId }
    );
    if (info.ok && info.channel?.last_read) {
      beforeLastRead = info.channel.last_read;
    }
  }

  const wm =
    opts.watermark === false
      ? ''
      : (opts.watermark !== undefined ? opts.watermark : getDefaultWatermark()).trim();

  const blocks = wm
    ? JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: wm }] },
      ])
    : undefined;

  const posted = await slackCall<{ ts?: string }>(account.name, 'chat.postMessage', {
    channel: channelId,
    text,
    blocks,
    thread_ts: opts.threadTs,
    reply_broadcast: opts.broadcast ? 'true' : undefined,
  });

  if (!posted.ok || !posted.ts) {
    throw new Error(`chat.postMessage failed: ${posted.error || 'unknown error'}`);
  }

  let restored = false;
  if (!opts.markRead && beforeLastRead) {
    const marked = await slackCall(account.name, 'conversations.mark', {
      channel: channelId,
      ts: beforeLastRead,
    });
    restored = Boolean(marked.ok);
  }

  return {
    ok: true,
    channelId,
    ts: posted.ts,
    threadTs: opts.threadTs,
    preservedLastRead: beforeLastRead,
    restored,
    watermark: wm || undefined,
  };
}
