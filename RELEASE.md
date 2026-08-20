# ZAGROOO Wizard

Installs and centrally manages ZAGROOO Panel deployments.

## What is new

- **Panel dashboard** at `/dashboard`: every ZAGROOO panel on the account in one
  place, with live usage, search and pagination up to 100+ panels.
- **Limit management**: total and daily volume, download and upload speed caps
  in KB/s, expiry dates, device limits and monthly resets — set per panel
  without logging into each one.
- **Plan templates** for common packages, so a new subscription is two clicks.
- **D1 provisioning**: each new panel gets a database for usage accounting.
  Panels without one fall back to buffered KV automatically.
- **Local edition**: `npm run local` serves the dashboard from your own machine
  with no worker deployed. A dependency-free Node server proxies the Cloudflare
  API, which the browser cannot call directly because the API sends no CORS
  headers for token requests.

## Upgrading existing panels

Panels installed by an earlier wizard have no D1 binding and keep using KV.
They still appear in the dashboard and are fully manageable; the dashboard
labels their storage so you can tell them apart.
