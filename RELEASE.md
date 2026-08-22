# ZAGROOO Wizard

Installs and centrally manages ZAGROOO Panel deployments.

## 1.2.0 — correctness

### New: templates

A Templates tab carrying the same twenty-four setups the panel ships. Apply one
to every panel you have selected, or save it as a ZagiRo profile and attach
quotas to it.

The list is vendored, so the wizard build never needs the network. Refresh it
after a panel release with `npm run sync-templates`.

### Fixed: most panels were unmanageable

The wizard read a panel's identity with a pattern that only matched the form it
writes at install. A panel writes a different form whenever you save anything
in its own admin UI — so the moment a panel was used at all, the wizard could
no longer update it, attach D1, or repair its links. Both forms are now
understood.

### Fixed: the account request bar always read 0%

The quota query needs the Account Analytics permission, which the "create a
token" link never asked for. A denial comes back as a success with an error
inside, so the bar showed a reassuring "0 of 100,000" — the one number meant to
warn you before every panel stops. The permission is now requested, the failure
is surfaced, and an unknown quota is shown as unknown.

**Re-create your API token from the install page, or add Account Analytics:
Read to the existing one.**

### Other fixes

- Updating a panel no longer destroys its secrets, variables, extra bindings or
  compatibility date.
- Attaching D1 checks the download first, so a Cloudflare error page can never
  be deployed as your worker, and no longer leaves an orphan database behind
  when it fails.
- Raising a limit revives a customer the panel had paused — that branch could
  never run before.
- The "Status notes in client" checkbox and the profile label now save.
- Pages panels can be repaired.
- A transient error no longer makes a panel vanish from the list.
- **Export CSV** now actually downloads, and loads every panel's details first
  instead of exporting blank rows for everything off the current page.
- Selecting panels then filtering no longer leaves a bulk action pointed at
  panels you cannot see.
- A failed install shows the error instead of a blank terminal.


## 1.1.0

### ZagiRo profiles

Saved bundles of limits and proxy settings. Build one, then apply it to any
panels you pick — individually or in bulk. A profile can carry:

- volume, speed and device limits
- "valid for N days", turned into a real expiry date when applied
- a full copy of another panel's proxy settings

Profiles double as plan templates in the panel editor, so the old hard-coded
templates are gone and yours take their place. They live in a KV namespace the
wizard creates on the account, so they follow the account rather than a browser.

### Account request guard

The free plan allows 100,000 Worker requests per day across the **whole
account**, not per worker. Twenty panels share one budget, and when it runs out
every customer stops at once. The dashboard now shows that budget with a
warning as it fills.

### Managing panels

- **Update from the dashboard**, one panel or many. Bulk updates are staged:
  the first panel is health-checked before the rest are touched, so a bad
  release cannot take every customer down at once.
- **Add D1** to a panel installed without one, without deleting it.
- **Repair links** for panels whose address the dashboard could not work out.
- **Copy buttons** for both the panel link and the subscriber portal link.
- **Bulk pause, resume and health check** across selected panels.
- **Sort** by usage, soonest expiry, or problems first.
- **Export** the panel list as CSV.
- **Quick extend** buttons: +7 or +30 days, +10 or +50 GB.

### Installing

- **Display name** on the install form, shown on the subscriber portal and
  throughout the dashboard.
- The panel's record is written at install, so a new panel is manageable
  before anyone opens it, and its links are known without guesswork.
- The token template now requests **D1 Edit**. Without it the panel silently
  fell back to KV, which allows far fewer writes per day.

### Local edition

`npm run local` now runs the same management code as the hosted wizard rather
than a parallel implementation, so it can no longer fall behind. It needs the
local server: a browser cannot call the Cloudflare API directly, because that
API sends no CORS headers for token-authenticated requests.

## Upgrading existing panels

Panels installed by an earlier wizard have no D1 binding and keep using KV.
They still appear in the dashboard and are fully manageable; use **Add D1** on
one to move it over, and **Repair links** if its links are blank.
