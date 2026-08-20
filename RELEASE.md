# ZAGROOO Wizard

Installs and centrally manages ZAGROOO Panel deployments.

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
