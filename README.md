<h1 align="center">ZAGROOO Wizard</h1>

## Introduction

**ZAGROOO Wizard** installs and manages [ZAGROOO Panel](https://github.com/rexteamiran/ZAG-Panel)
deployments on Cloudflare Workers and Pages.

The panel is the API: every panel serves its own management API secured by an
API key. The wizard's dashboard signs you in, connects to your panels through
those APIs, and manages all of them from one place — the browser talks to the
panels directly, so managing a hundred panels costs the wizard no request
quota.

## Editions

| Edition | How to run it | Notes |
| --- | --- | --- |
| **Hosted worker** | Deploy this repo to Cloudflare Workers | Install panels at `/`, manage them at `/dashboard` |

The dashboard has its own accounts: registration requires the invite code you
set as the `WIZARD_INVITE_CODE` secret. With the secret unset, registration is
closed and existing accounts keep working.

## What the wizard does

- Installs one panel — or a whole group of up to twenty — from a single
  Cloudflare API token. Unnamed panels are numbered automatically
  (`zag1`, `zag2`, … `zag20`), and the counter continues on your next install.
- All panels of one account share a single D1 database, each namespaced with
  its own panel id, so the free plan's ten-database cap never limits how many
  panels you run.
- Every panel gets a **Dashboard API key** at install — add it once on the
  dashboard's API page and the panel is yours to manage.
- Manages connected panels through their own APIs: quotas, daily caps,
  download/upload speed limits, expiry dates, device limits, monthly resets,
  pause/resume, usage resets and self-updates to the latest release.
- ZagiRo profiles: saved bundles of limits and proxy settings, applied to any
  set of panels. Setting templates (the panel's own library) can be applied
  the same way.

## Deploying the wizard

1. Add three repository secrets under *Settings → Secrets and variables →
   Actions*:
   - `CLOUDFLARE_API_TOKEN` — Workers Scripts Edit, D1 Edit, Account Settings Read
   - `WIZARD_SECRET` — any long random string; encrypts stored panel API keys
   - `WIZARD_INVITE_CODE` — the sign-up code (leave unset to close registration)
2. Run the **Deploy Wizard** workflow. It provisions the wizard's D1 database
   and deploys the worker.
3. Open the wizard, install panels, and connect them on the dashboard.

The wizard CLI (the Go binary built from this repo) remains install-only, for
machines where opening a browser is awkward.

## Storage

- The **wizard's** database (`zagrooo-wizard`) holds accounts, sessions,
  connections, profiles and install counters. Panel API keys are encrypted at
  rest with `WIZARD_SECRET`.
- Every **panel** binds one shared account database (`zagrooo-panels`) as
  `zag_db`. Panels deployed before 1.3.0 cannot self-update into this
  architecture — reinstall them once with the current wizard.

## Credits

ZAGROOO Wizard is a fork of [BPB-Wizard](https://github.com/bia-pain-bache/BPB-Wizard)
by bia-pain-bache, licensed under GPL-3.0. Thanks to the original authors and
contributors.

## License

[GPL-3.0](LICENSE)
