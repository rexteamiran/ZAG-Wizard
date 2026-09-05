# ZAGROOO Wizard

## 1.3.1 — the event log

New: `/log`. Installs and their outcomes, sign-ins and their failures, and
every request that died are recorded in the wizard's own database and shown
on one page — what happened, from which subsystem, when, with the detail
underneath. Filter by level or text, clear in one click. Reading it needs a
signed-in account. Also fixes the deploy workflow: the provision step now
searches every page of the D1 list, falls back to a direct name lookup, and
reuses an existing database instead of failing when the account is at the
ten-database cap.

## 1.3.0 — accounts, group install and a panel-API dashboard

### The dashboard became an account-based app

- Sign in with email and password; registration is gated by the
  `WIZARD_INVITE_CODE` deploy secret. Passwords are PBKDF2-hashed, sessions
  are hashed server-side, and no user can ever see another user's panels.
- Panels are added on the dashboard's API page with a panel address and the
  API key handed out at install. The browser then talks to each panel's API
  directly — managing panels no longer consumes the wizard's request quota.

### Group install

- One form installs up to twenty panels at once. Unnamed panels count from a
  global counter (`zag1`…`zag5` this install, `zag6` onward the next); a name
  prefixes every panel instead (`Ali-1`, `Ali-2`, …).
- All panels of an account share one D1 database (`zagrooo-panels`), each
  namespaced by panel id. The free plan's ten-database cap no longer bounds
  panel count.

### Removed

- The Cloudflare-token dashboard: account request-quota card, panel discovery,
  repair links, add-D1 and private install links are all gone. The token is
  used only on the install page and only for the length of one install.
- The local edition (`npm run local`) and its Node server — its CORS proxy was
  the reason it existed, and the new dashboard talks to panels directly.
- KV everywhere. Panels store everything in D1.

### Upgrading

Panels deployed before 1.3.0 must be reinstalled once with this wizard —
their old KV-based builds cannot self-update into the D1-only architecture.

## 1.2.1

- Wizard worker for the 1.2.x panel line: multi-panel dashboard, D1
  provisioning, ZagiRo profiles and the local edition.
