<h1 align="center">ZAGROOO Wizard</h1>

## Introduction

**ZAGROOO Wizard** installs and centrally manages [ZAGROOO Panel](https://github.com/rexteamiran/ZAG-Panel)
deployments on Cloudflare Workers and Pages.

One wizard manages every panel on your account: usage quotas, speed caps, expiry
dates, subscriber links and the panels themselves.

## Editions

| Edition | How to run it | Notes |
| --- | --- | --- |
| **Hosted worker** | Deploy this repo to Cloudflare Workers | Install panels and manage them at `/dashboard` |
| **CLI** | `install.sh` / `install.ps1` | Install-only, runs on Linux, macOS, Windows and Termux |
| **Local page** | `npm run local` | Management only, runs on your own machine |

## What the wizard does

- Creates the worker or Pages project, its KV namespace and its D1 database
- Lists every ZAGROOO panel on the account, with live usage per panel
- Edits total and daily volume caps, download and upload speed caps (KB/s),
  expiry dates, device limits and monthly resets
- Pauses, resumes, resets usage counters and deletes panels
- Copies subscriber portal links, with plan templates for common packages

## The local edition

Manage every panel from your own machine, with no worker deployed:

```
npm install
npm run local
```

Then open <http://127.0.0.1:8787> and paste a Cloudflare API token.

Nothing is uploaded anywhere and nothing is written to disk. The token goes
browser to local server to Cloudflare, and is gone when you stop the process.

### Why it needs a server

`local.html` cannot be opened straight from disk. `api.cloudflare.com` sends no
`Access-Control-Allow-Origin` header on token-authenticated requests, so the
browser blocks every call before it leaves the page. `scripts/local-server.mjs`
is a dependency-free Node server that serves the page and proxies `/cf/*` to the
Cloudflare API, which makes those calls same-origin. It binds to `127.0.0.1`
only.

To rebuild just the page without starting the server:

```
npm run build-local
```

### Token scopes

Create a token with only what the wizard needs:

- Workers Scripts: Edit
- Workers KV Storage: Edit
- D1: Edit
- Cloudflare Pages: Edit
- Account Settings: Read
- User Details: Read

Never use a Global API Key. Anyone with access to the browser profile that
holds the token has the same access to your Cloudflare account.

## Storage

Usage counters go to D1, which allows far more writes per day than KV on the
free plan. Panels deployed before D1 support fall back to buffered KV
accounting automatically — the wizard shows which store each panel uses.

## Credits

ZAGROOO Wizard is a fork of [BPB-Wizard](https://github.com/bia-pain-bache/BPB-Wizard)
by bia-pain-bache, licensed under GPL-3.0. Thanks to the original authors and
contributors.

## License

[GPL-3.0](LICENSE)
