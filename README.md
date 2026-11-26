# slackctl

A fast, multi-account Slack CLI powered by your own browser session. It reads channels, DMs, and threads — and even replies — **without marking conversations as read**.

No Slack App installation or workspace admin approval required.

## How it works

- **Never loads the Slack web UI:** Once authenticated, `slackctl` opens only `https://<workspace>.slack.com/robots.txt` inside a headless Chromium instance and calls Slack's Web API (`/api/*`) directly with your browser session cookies. Because the Slack client UI never loads, reading messages never advances your read cursor.
- **Unread-safe replies:** `slackctl reply` snapshots `last_read` via `conversations.info`, sends via `chat.postMessage`, and restores `last_read` via `conversations.mark` (unless `--mark-read` is passed).
- **Lazy per-account daemon:** Each account runs its own lightweight background daemon over a Unix socket (`~/.local/state/slackctl/<account>.sock`). It starts automatically on your first command and shuts down after 15 minutes of inactivity (configurable via `SLACKCTL_IDLE_MS`).
- **One isolated browser profile per account:** Each account gets its own Chromium `userDataDir` under `~/.local/share/slackctl/profiles/<account>` (mode `0700`). No tokens are written to plain-text config files. You can also attach to an existing Chrome over CDP (`--cdp http://127.0.0.1:9222`).

## Install

```bash
npm install
npm run build
npm link
```

## Authentication

### 1. Managed browser profile (opens a headed Chromium window)

```bash
slackctl auth login work
```

Sign in to your Slack workspace in the Chromium window (SSO, Okta, Google, 2FA all work). `slackctl` detects your workspace automatically, saves non-secret account metadata, and closes the window.

### 2. Attach to an existing Chrome over CDP (optional)

```bash
slackctl auth attach work --cdp http://127.0.0.1:9222 [--domain mycompany]
```

### Manage accounts

```bash
slackctl auth list
slackctl auth use work
slackctl auth logout work
```

## Commands

Pass `-a <account>` / `--account <account>` on any command to target a non-default account, or `--json` for raw JSON output.

```bash
# Unread DMs, group DMs, mentions, and unread channels
slackctl unreads

# Read a channel, DM (@username), or thread without marking read
slackctl read #general --limit 20
slackctl read @alice
slackctl read C0123456789 --thread 1700000000.123456

# Unread / recent threads
slackctl threads

# Search messages
slackctl search "deploy error"

# Reply without advancing your read cursor (adds a subtle "Sent via AI" sub-caption by default)
slackctl reply @alice "On it!"
slackctl reply #general "Fixed in PR #42" --thread 1700000000.123456
slackctl reply @alice "Got it" --mark-read --no-watermark

# Customize or disable the reply watermark
slackctl config get watermark
slackctl config set watermark "Sent via AI"
slackctl config set watermark ""

# Raw Slack Web API call
slackctl api auth.test

# Manage background daemons
slackctl daemon status
slackctl daemon stop
slackctl daemon stop --all
```

## Environment variables

- `SLACKCTL_IDLE_MS` — Daemon idle timeout in milliseconds (default: `900000` = 15 minutes)
- `SLACKCTL_CONFIG_DIR` / `SLACKCTL_DATA_DIR` / `SLACKCTL_STATE_DIR` / `SLACKCTL_CACHE_DIR` — Override XDG paths

## Disclaimer

`slackctl` automates your own logged-in browser session to call Slack's Web API. Make sure this complies with your organization's policies.
