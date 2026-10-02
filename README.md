# Pisell Ticket Collector

This repository is the Git-backed Codex marketplace for the Pisell Feishu ticket collector. The plugin source lives at `plugins/lark-ticket-collector`; production secrets and runtime state stay on each host.

## Security boundary

Never commit:

- `plugins/lark-ticket-collector/bridge/.env`
- Feishu App Secret, OAuth tokens, or Codex credentials
- `bridge/var/` SQLite databases and downloaded attachments
- `bridge/dist/`, `bridge/node_modules/`, or a live ticket workspace

Production group IDs are read from local environment variables:

```dotenv
YOKO_HANDOFF_CHAT_ID=oc_xxx
CONTENT_PRODUCER_SOURCE_CHAT_ID=oc_xxx
```

The checked-in `.env.example` contains placeholders only.

## Install the plugin on a Mac mini

Install the GitHub marketplace and plugin:

```bash
codex plugin marketplace add JingyueCong/pisell_ticket --ref main
codex plugin add lark-ticket-collector@pisell-ticket
```

Clone the repository for the bridge process:

```bash
git clone https://github.com/JingyueCong/pisell_ticket.git
cd pisell_ticket/plugins/lark-ticket-collector/bridge
npm ci
cp .env.example .env
```

Edit `.env` locally. Copying the existing MacBook `.env` to the Mac mini over a secure local channel is supported; do not transfer it through GitHub.

Prepare the dedicated workspace and authenticate the local tools:

```bash
npm run workspace:init -- "$HOME/pisell-ticket-workspace"
meegle auth login --host project.feishu.cn
lark-cli --profile ticket-collector whoami
codex login
```

Set `BRIDGE_WORKSPACE` in `.env` to the generated absolute path, then validate and start:

```bash
npm run typecheck
npm test
node --env-file=.env --import tsx src/doctor.ts
npm run build
node --env-file=.env dist/src/main.js
```

When the MacBook and Mac mini use the same Feishu App, run only one bridge at a time because their local SQLite idempotency databases are not shared.

## Update workflow

After pulling a release on the Mac mini:

```bash
codex plugin marketplace upgrade pisell-ticket
codex plugin add lark-ticket-collector@pisell-ticket
cd plugins/lark-ticket-collector/bridge
npm ci
npm run typecheck
npm test
npm run build
```

Restart the bridge process after rebuilding. Start a new Codex conversation when testing changed plugin instructions.

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/lark-ticket-collector/
  .codex-plugin/plugin.json
  skills/
  workspace/
  bridge/
```
