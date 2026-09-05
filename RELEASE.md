# ZAGROOO Wizard

## 1.3.2 — design system v2, and a full engineering pass

The install page now follows the shared design system (see DESIGN.md): one
clay action per view, inputs carved from the field well, colour-only hover
states, and result cards on proper radii with mono tabular keys. theme.css
is byte-identical with the panel's copy.

A full review also fixed defects that shipped in earlier versions:

- Group installs capped at six panels per run: every panel used to
  re-download the panel script and re-fetch the account subdomain, burning
  ~7 subrequests each — past panel six or seven, the free plan's 50-
  subrequest budget died mid-install and every remaining panel failed.
- A brand-new account's workers.dev subdomain was embedded without its
  ".workers.dev" suffix, making the first installed panel unreachable.
- Two installs racing the shared-database create failed on "already
  exists"; they now re-look-up and continue.
- The log page's "clear" button deleted nothing (it called the read route).
- The event log recorded every user's full email and was readable by every
  signed-in account; emails are redacted at the boundary now.
- Expired sessions were never deleted; a purge rides along with each login.
- Login leaked whether an email was registered, by timing; the invite code
  is now compared in constant time.
- Dashboard cards escaped neither panel-reported hosts and errors nor
  connection labels and profile names (XSS); all go through escapeHtml.
- The CLI's release workflow died on a script removed in 1.3.0, so no CLI
  binary was ever published from this line — installers downloaded a 404.
  The workflow is fixed and publishes binaries again.
- The CLI generated the panel's secret path and Trojan password with
  math/rand, accepted negative menu input (crash), crashed on expired
  tokens, and — missing the D1 permission in its token template — deployed
  panels that die on their own reinstall page. All fixed; D1 is now
  required, the dead KV fallback is gone, and secrets use crypto/rand.
- install.sh no longer happily un-tars a 404 page (set -euo pipefail,
  curl -f); install.ps1 forces TLS 1.2 for Windows PowerShell 5.1.

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
