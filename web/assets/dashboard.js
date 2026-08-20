/* ==========================================================================
   ZAGROOO Wizard dashboard

   Every request goes through /api/manage/*, which both the hosted worker and
   the local server expose, running the same code. Credentials live in memory
   for the session only: either the `key` from a private install link, or a
   token typed in here.
   ========================================================================== */

const GB = 1024 ** 3;
const PAGE_SIZE = 12;
const DAY = 86400000;

const credential = {};
let panels = [];
let filtered = [];
let details = new Map();
let selected = new Set();
let profiles = [];
let page = 0;
let current = null;
let currentProfile = null;
let pendingSettings = null;

const $ = id => document.getElementById(id);

/* -------------------------------------------------------------- transport */

async function manage(action, payload = {}) {
    const res = await fetch(`/api/manage/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...credential, ...payload })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.message || `Request failed (${res.status})`);
    return data.body ?? {};
}

/* ----------------------------------------------------------------- format */

function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 2)} ${units[exponent]}`;
}

function pillClass(status) {
    if (status === 'active') return 'pill';
    if (status === 'paused' || status === 'expired') return 'pill is-danger';
    if (status === 'unknown') return 'pill is-muted';
    return 'pill is-warn';
}

function barClass(pct) {
    if (pct >= 95) return 'bar is-danger';
    if (pct >= 80) return 'bar is-warn';
    return 'bar';
}

function daysLeft(expireAt) {
    return expireAt ? Math.ceil((expireAt - Date.now()) / DAY) : null;
}

let toastTimer = 0;

function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2800);
}

/* ------------------------------------------------------------------ boot */

(function boot() {
    // A private install link carries ?key=… — reuse it so the operator does
    // not have to paste a token at all.
    const key = new URLSearchParams(location.search).get('key');
    if (key) {
        credential.key = key;
        connect();
    }
})();

$('connect').addEventListener('click', () => {
    const token = $('token').value.trim();
    if (!token) {
        toast('Paste a Cloudflare API token first.');
        return;
    }

    credential.token = token;
    connect();
});

$('token').addEventListener('keydown', event => {
    if (event.key === 'Enter') $('connect').click();
});

async function connect() {
    try {
        const account = await manage('account');
        $('account').textContent = account.email;
        $('connect-card').hidden = true;
        $('tabs').hidden = false;
        $('panels-section').hidden = false;
        $('quota-card').hidden = false;

        await loadPanels();
        await Promise.all([loadProfiles(), loadAccountUsage()]);
    } catch (error) {
        toast(String(error.message || error));
    }
}

/* --------------------------------------------------------- account quota */

async function loadAccountUsage() {
    try {
        const usage = await manage('account-usage');
        const pct = usage.percent;

        $('quota-bar').style.width = `${pct}%`;
        $('quota-bar').className = barClass(pct);
        $('quota-text').textContent =
            `${usage.requests.toLocaleString()} of ${usage.limit.toLocaleString()} requests in the last 24 hours`;

        const pill = $('quota-pill');
        pill.textContent = `${pct.toFixed(1)}%`;
        pill.className = pct >= 90 ? 'pill is-danger' : pct >= 70 ? 'pill is-warn' : 'pill';
    } catch (error) {
        $('quota-text').textContent = `Could not read account usage: ${error.message || error}`;
    }
}

/* ----------------------------------------------------------------- tabs */

$('tabs').addEventListener('click', event => {
    const tab = event.target.closest('.tab');
    if (!tab) return;

    document.querySelectorAll('.tab').forEach(node => node.classList.remove('is-active'));
    tab.classList.add('is-active');

    $('panels-section').hidden = tab.dataset.tab !== 'panels';
    $('zagiro-section').hidden = tab.dataset.tab !== 'zagiro';
});

/* ---------------------------------------------------------------- listing */

async function loadPanels() {
    $('panels').innerHTML = '<div class="empty">Loading panels…</div>';

    try {
        const body = await manage('panels');
        panels = body.panels || [];
        details = new Map();
        selected = new Set();
        applyFilter();
    } catch (error) {
        $('panels').innerHTML = `<div class="empty">${error.message || error}</div>`;
    }
}

function sortPanels(list) {
    const mode = $('sort').value;
    const detailOf = panel => details.get(cardId(panel)) || {};
    const copy = [...list];

    if (mode === 'usage') {
        copy.sort((a, b) => ((detailOf(b).usage || {}).totalBytes || 0) - ((detailOf(a).usage || {}).totalBytes || 0));
    } else if (mode === 'expiry') {
        copy.sort((a, b) =>
            ((detailOf(a).limits || {}).expireAt || Infinity) - ((detailOf(b).limits || {}).expireAt || Infinity));
    } else if (mode === 'status') {
        const rank = panel => (detailOf(panel).status === 'active' ? 1 : 0);
        copy.sort((a, b) => rank(a) - rank(b));
    } else {
        copy.sort((a, b) => a.name.localeCompare(b.name));
    }

    return copy;
}

function applyFilter() {
    const query = $('search').value.trim().toLowerCase();
    const matches = query
        ? panels.filter(panel => {
            const detail = details.get(cardId(panel)) || {};
            const name = ((detail.limits || {}).displayName || '').toLowerCase();
            return panel.name.toLowerCase().includes(query) || name.includes(query);
        })
        : panels;

    filtered = sortPanels(matches);
    page = 0;
    renderPage();
}

function renderPage() {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages - 1);

    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    $('count').textContent = `${filtered.length} panel${filtered.length === 1 ? '' : 's'}`;
    $('pager').hidden = totalPages < 2;
    $('page-label').textContent = `Page ${page + 1} of ${totalPages}`;
    $('bulkbar').hidden = filtered.length === 0;

    if (!slice.length) {
        $('panels').innerHTML = '<div class="empty">No ZAGROOO panels found on this account.</div>';
        return;
    }

    $('panels').innerHTML = slice.map(cardMarkup).join('');
    updateSelectionUi();

    // Stats are fetched lazily so a hundred panels do not mean a hundred
    // blocking round trips before anything renders.
    slice.forEach(panel => {
        const cached = details.get(cardId(panel));
        if (cached) paintDetail(panel, cached); else loadDetail(panel);
    });
}

function cardMarkup(panel) {
    const id = cardId(panel);
    return `<article class="panel-card" id="${id}">
        <div class="panel-card-head">
            <label class="check-inline">
                <input type="checkbox" class="select-panel" data-id="${id}" ${selected.has(id) ? 'checked' : ''} />
                <span>
                    <strong data-role="title">${panel.name}</strong>
                    <span class="panel-meta">${panel.deployType}${panel.hasD1 ? ' · D1' : ' · KV'}<span data-role="profile"></span></span>
                </span>
            </label>
            <span class="pill is-muted" data-role="status">loading</span>
        </div>
        <div class="usage-line"><span>Total</span><b data-role="total">—</b></div>
        <div class="track"><span class="bar" data-role="bar"></span></div>
        <div class="usage-line"><span>Today</span><b data-role="daily">—</b></div>
        <div class="usage-line"><span>Expires</span><b data-role="expiry">—</b></div>
        <div class="panel-links" data-role="links"></div>
    </article>`;
}

function cardId(panel) {
    return `panel-${panel.deployType}-${panel.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function panelOfId(id) {
    return panels.find(panel => cardId(panel) === id);
}

async function loadDetail(panel) {
    try {
        const detail = await manage('detail', { panel });
        details.set(cardId(panel), detail);
        paintDetail(panel, detail);
    } catch (error) {
        const card = document.getElementById(cardId(panel));
        if (card) card.querySelector('[data-role="status"]').textContent = 'error';
    }
}

function paintDetail(panel, detail) {
    const card = document.getElementById(cardId(panel));
    if (!card) return;

    const limits = detail.limits || {};
    const usage = detail.usage || {};
    const total = usage.totalBytes || 0;
    const pct = limits.limitTotalBytes ? Math.min(100, (total / limits.limitTotalBytes) * 100) : 0;

    if (limits.displayName) {
        card.querySelector('[data-role="title"]').textContent = `${limits.displayName} · ${panel.name}`;
    }

    card.querySelector('[data-role="profile"]').textContent = limits.zagiroName ? ` · ${limits.zagiroName}` : '';

    const status = card.querySelector('[data-role="status"]');
    status.textContent = detail.status;
    status.className = pillClass(detail.status);

    card.querySelector('[data-role="total"]').textContent = limits.limitTotalBytes
        ? `${fmtBytes(total)} / ${fmtBytes(limits.limitTotalBytes)}`
        : fmtBytes(total);
    card.querySelector('[data-role="daily"]').textContent = limits.limitDailyBytes
        ? `${fmtBytes(usage.dailyBytes || 0)} / ${fmtBytes(limits.limitDailyBytes)}`
        : fmtBytes(usage.dailyBytes || 0);

    const days = daysLeft(limits.expireAt);
    card.querySelector('[data-role="expiry"]').textContent =
        days === null ? 'never' : days < 0 ? 'expired' : `${days} day${days === 1 ? '' : 's'}`;

    const bar = card.querySelector('[data-role="bar"]');
    bar.style.width = `${pct}%`;
    bar.className = barClass(pct);

    const links = [`<button type="button" data-edit="${cardId(panel)}">Manage</button>`];

    if (detail.panelUrl) {
        links.push(`<a href="${detail.panelUrl}" target="_blank" rel="noopener">Panel ↗</a>`);
        links.push(`<button type="button" data-copy="${detail.panelUrl}">Copy panel</button>`);
    }

    if (detail.portalUrl) {
        links.push(`<a href="${detail.portalUrl}" target="_blank" rel="noopener">Portal ↗</a>`);
        links.push(`<button type="button" data-copy="${detail.portalUrl}">Copy portal</button>`);
    }

    if (!detail.panelUrl || !detail.portalUrl) {
        links.push(`<button type="button" data-repair="${cardId(panel)}">Repair links</button>`);
    }

    if (detail.error) links.push(`<span class="small">${detail.error}</span>`);

    card.querySelector('[data-role="links"]').innerHTML = links.join('');
}

/* ------------------------------------------------------------- selection */

function updateSelectionUi() {
    $('selected-count').textContent = `${selected.size} selected`;
    const boxes = document.querySelectorAll('.select-panel');
    $('select-all').checked = boxes.length > 0 && [...boxes].every(box => box.checked);
}

document.addEventListener('change', event => {
    if (event.target.classList.contains('select-panel')) {
        const id = event.target.dataset.id;
        if (event.target.checked) selected.add(id); else selected.delete(id);
        updateSelectionUi();
        return;
    }

    if (event.target.id === 'select-all') {
        document.querySelectorAll('.select-panel').forEach(box => {
            box.checked = event.target.checked;
            if (box.checked) selected.add(box.dataset.id); else selected.delete(box.dataset.id);
        });
        updateSelectionUi();
    }
});

function selectedPanels() {
    return [...selected].map(panelOfId).filter(Boolean);
}

/* --------------------------------------------------------------- actions */

document.addEventListener('click', async event => {
    const copyBtn = event.target.closest('[data-copy]');
    if (copyBtn) {
        try {
            await navigator.clipboard.writeText(copyBtn.dataset.copy);
            toast('Copied');
        } catch (error) {
            toast('Copy failed');
        }
        return;
    }

    const repairBtn = event.target.closest('[data-repair]');
    if (repairBtn) {
        const panel = panelOfId(repairBtn.dataset.repair);
        try {
            await manage('repair', { panel });
            toast('Links repaired.');
            await loadDetail(panel);
        } catch (error) {
            toast(String(error.message || error));
        }
        return;
    }

    const editBtn = event.target.closest('[data-edit]');
    if (editBtn) {
        openEditor(editBtn.dataset.edit);
        return;
    }

    if (event.target.closest('#edit-close') || event.target.id === 'edit-modal') {
        $('edit-modal').hidden = true;
        return;
    }

    if (event.target.closest('#profile-close') || event.target.id === 'profile-modal') {
        $('profile-modal').hidden = true;
        return;
    }

    const planBtn = event.target.closest('[data-plan]');
    if (planBtn) {
        const profile = profiles.find(p => p.id === planBtn.dataset.plan);
        if (profile) fillFromProfile(profile);
        return;
    }

    const extendDays = event.target.closest('[data-extend-days]');
    if (extendDays) {
        const days = Number(extendDays.dataset.extendDays);
        const base = $('f-expiry').value ? new Date(`${$('f-expiry').value}T23:59:59Z`).getTime() : Date.now();
        $('f-expiry').value = new Date(Math.max(base, Date.now()) + days * DAY).toISOString().split('T')[0];
        return;
    }

    const extendGb = event.target.closest('[data-extend-gb]');
    if (extendGb) {
        const value = parseFloat($('f-total').value || '0');
        $('f-total').value = +(value + Number(extendGb.dataset.extendGb)).toFixed(2);
        return;
    }

    const profileBtn = event.target.closest('[data-profile]');
    if (profileBtn) {
        openProfile(profiles.find(p => p.id === profileBtn.dataset.profile) || null);
    }
});

/* ---------------------------------------------------------- panel editor */

function openEditor(id) {
    const detail = details.get(id);
    if (!detail) return;

    current = detail;
    const limits = detail.limits || {};

    $('edit-title').textContent =
        `${limits.displayName ? limits.displayName + ' · ' : ''}${detail.name} · ${detail.host || detail.deployType}`;
    $('f-name').value = limits.displayName || '';
    $('f-total').value = limits.limitTotalBytes ? +(limits.limitTotalBytes / GB).toFixed(2) : 0;
    $('f-daily').value = limits.limitDailyBytes ? +(limits.limitDailyBytes / GB).toFixed(2) : 0;
    $('f-down').value = limits.downSpeedKbps || 0;
    $('f-up').value = limits.upSpeedKbps || 0;
    $('f-devices').value = limits.maxDevices || 0;
    $('f-reset-day').value = limits.monthlyResetDay || 1;
    $('f-monthly').checked = Boolean(limits.monthlyReset);
    $('f-alert-quota').checked = Boolean(limits.alertQuota);
    $('f-alert-expiry').checked = Boolean(limits.alertExpiry);
    $('f-status-nodes').checked = limits.showStatusNodes !== false;
    $('f-expiry').value = limits.expireAt ? new Date(limits.expireAt).toISOString().split('T')[0] : '';
    $('edit-pause').textContent = limits.isPaused ? 'Resume' : 'Pause';
    $('edit-addd1').hidden = Boolean(detail.hasD1);

    renderPlanButtons();
    $('edit-modal').hidden = false;
}

function renderPlanButtons() {
    const usable = profiles.filter(p => (p.limits && Object.keys(p.limits).length) || p.validDays);

    $('plan-buttons').innerHTML = usable.length
        ? usable.map(p => `<button class="chip-btn" data-plan="${p.id}" type="button">${p.name}</button>`).join('')
        : '<span class="muted small">No profiles yet — create one in the ZagiRo tab.</span>';
}

function fillFromProfile(profile) {
    const limits = profile.limits || {};
    if (limits.limitTotalBytes !== undefined) $('f-total').value = +(limits.limitTotalBytes / GB).toFixed(2);
    if (limits.limitDailyBytes !== undefined) $('f-daily').value = +(limits.limitDailyBytes / GB).toFixed(2);
    if (limits.downSpeedKbps !== undefined) $('f-down').value = limits.downSpeedKbps;
    if (limits.upSpeedKbps !== undefined) $('f-up').value = limits.upSpeedKbps;
    if (limits.maxDevices !== undefined) $('f-devices').value = limits.maxDevices;
    if (profile.validDays) {
        $('f-expiry').value = new Date(Date.now() + profile.validDays * DAY).toISOString().split('T')[0];
    }

    toast(`Filled from ${profile.name}`);
}

function panelRef(detail) {
    return {
        name: detail.name,
        deployType: detail.deployType,
        modifiedOn: detail.modifiedOn,
        hasKv: detail.hasKv,
        hasD1: detail.hasD1
    };
}

function limitsFromForm() {
    const expiry = $('f-expiry').value;
    return {
        displayName: $('f-name').value.trim(),
        limitTotalBytes: Math.round(parseFloat($('f-total').value || '0') * GB),
        limitDailyBytes: Math.round(parseFloat($('f-daily').value || '0') * GB),
        downSpeedKbps: parseInt($('f-down').value || '0', 10),
        upSpeedKbps: parseInt($('f-up').value || '0', 10),
        maxDevices: parseInt($('f-devices').value || '0', 10),
        monthlyResetDay: parseInt($('f-reset-day').value || '1', 10),
        monthlyReset: $('f-monthly').checked,
        alertQuota: $('f-alert-quota').checked,
        alertExpiry: $('f-alert-expiry').checked,
        showStatusNodes: $('f-status-nodes').checked,
        // End of the chosen day, so an expiry set to today still works today.
        expireAt: expiry ? new Date(`${expiry}T23:59:59Z`).getTime() : 0
    };
}

$('edit-save').addEventListener('click', () =>
    runAction('limits', { panel: panelRef(current), patch: limitsFromForm() }, 'Limits saved.'));

$('edit-pause').addEventListener('click', () => {
    const paused = !(current.limits && current.limits.isPaused);
    runAction('pause', { panel: panelRef(current), paused }, paused ? 'Panel paused.' : 'Panel resumed.');
});

$('edit-reset').addEventListener('click', () => {
    if (!confirm(`Reset all usage counters for ${current.name}? This cannot be undone.`)) return;
    runAction('reset-usage', { panel: panelRef(current), scope: 'all' }, 'Usage reset.');
});

$('edit-repair').addEventListener('click', () =>
    runAction('repair', { panel: panelRef(current) }, 'Links repaired.'));

$('edit-update').addEventListener('click', () => {
    if (!confirm(`Update ${current.name} to the latest release?`)) return;
    runAction('update-panel', { panel: panelRef(current) }, 'Panel updated.');
});

$('edit-addd1').addEventListener('click', () => {
    if (!confirm(`Attach a D1 database to ${current.name} and redeploy it?`)) return;
    runAction('add-d1', { panel: panelRef(current) }, 'D1 attached.');
});

$('edit-delete').addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${current.name} from Cloudflare? This cannot be undone.`)) return;

    try {
        await manage('delete', { panel: panelRef(current) });
        toast('Panel deleted.');
        $('edit-modal').hidden = true;
        await loadPanels();
    } catch (error) {
        toast(String(error.message || error));
    }
});

async function runAction(action, payload, okMessage) {
    if (!current) return;

    try {
        await manage(action, payload);
        toast(okMessage);

        const refreshed = await manage('detail', { panel: panelRef(current) });
        details.set(cardId(current), refreshed);
        current = refreshed;
        paintDetail(current, refreshed);
        $('edit-pause').textContent = (refreshed.limits || {}).isPaused ? 'Resume' : 'Pause';
        $('edit-addd1').hidden = Boolean(refreshed.hasD1);
    } catch (error) {
        toast(String(error.message || error));
    }
}

/* ---------------------------------------------------------- bulk actions */

async function bulk(label, worker, { staged = false } = {}) {
    const targets = selectedPanels();
    if (!targets.length) {
        toast('Select some panels first.');
        return;
    }

    if (!confirm(`${label} ${targets.length} panel(s)?`)) return;

    let done = 0;
    const failures = [];

    for (const panel of targets) {
        try {
            await worker(panel);
            done++;

            // Staged: prove the first one survived before touching the rest,
            // so a bad release cannot take every customer down at once.
            if (staged && done === 1 && targets.length > 1) {
                const health = await manage('health', { panel });
                if (!health.ok) {
                    failures.push(`${panel.name} unhealthy after the change (${health.detail}) — stopped here`);
                    break;
                }

                toast(`First panel healthy, continuing with ${targets.length - 1} more…`);
            }
        } catch (error) {
            failures.push(`${panel.name}: ${error.message || error}`);
        }
    }

    toast(failures.length ? `${done} done, ${failures.length} failed. ${failures[0]}` : `${label}: ${done} done.`);
    await loadPanels();
}

$('bulk-apply').addEventListener('click', () => {
    const profile = profiles.find(p => p.id === $('bulk-profile').value);
    if (!profile) {
        toast('Choose a profile first.');
        return;
    }

    bulk(`Apply "${profile.name}" to`, panel =>
        manage('apply-profile', { panel, profile: profileForApply(profile) }));
});

$('bulk-update').addEventListener('click', () =>
    bulk('Update', panel => manage('update-panel', { panel }), { staged: true }));

$('bulk-pause').addEventListener('click', () =>
    bulk('Pause', panel => manage('pause', { panel, paused: true })));

$('bulk-resume').addEventListener('click', () =>
    bulk('Resume', panel => manage('pause', { panel, paused: false })));

$('bulk-health').addEventListener('click', async () => {
    const targets = selectedPanels();
    if (!targets.length) {
        toast('Select some panels first.');
        return;
    }

    const results = await Promise.all(targets.map(async panel => {
        const health = await manage('health', { panel }).catch(error => ({ ok: false, detail: String(error) }));
        return { panel, health };
    }));

    const bad = results.filter(result => !result.health.ok);
    toast(bad.length
        ? `${bad.length} unreachable: ${bad.map(result => result.panel.name).join(', ')}`
        : `All ${results.length} panels reachable.`);
});

/* -------------------------------------------------------------- ZagiRo UI */

async function loadProfiles() {
    try {
        const body = await manage('profiles');
        profiles = body.profiles || [];
    } catch (error) {
        profiles = [];
        toast(`Could not load profiles: ${error.message || error}`);
    }

    renderProfiles();
    renderProfileSelects();
}

function renderProfiles() {
    $('profiles').innerHTML = profiles.length
        ? profiles.map(profile => {
            const carries = [
                profile.limits && 'limits',
                profile.settings && 'proxy settings',
                profile.validDays && `${profile.validDays} days`
            ].filter(Boolean).join(' + ') || 'empty';

            return `<article class="panel-card">
                <div class="panel-card-head">
                    <div>
                        <strong>${profile.name}</strong>
                        <span class="panel-meta">${profile.note || 'No note'}</span>
                    </div>
                    <span class="pill is-muted">${carries}</span>
                </div>
                <div class="usage-line"><span>Updated</span><b>${new Date(profile.updatedAt).toLocaleDateString()}</b></div>
                <div class="panel-links">
                    <button type="button" data-profile="${profile.id}">Edit</button>
                </div>
            </article>`;
        }).join('')
        : '<div class="empty">No profiles yet. Create one to reuse settings across panels.</div>';
}

function renderProfileSelects() {
    $('bulk-profile').innerHTML = ['<option value="">Apply ZagiRo profile…</option>']
        .concat(profiles.map(p => `<option value="${p.id}">${p.name}</option>`))
        .join('');

    $('p-source').innerHTML = ['<option value="">Copy proxy settings from a panel…</option>']
        .concat(panels.map(p => `<option value="${cardId(p)}">${p.name}</option>`))
        .join('');
}

$('profile-new').addEventListener('click', () => openProfile(null));

function openProfile(profile) {
    currentProfile = profile;
    const limits = (profile && profile.limits) || {};

    $('profile-title').textContent = profile ? `Edit ${profile.name}` : 'New ZagiRo profile';
    $('p-name').value = (profile && profile.name) || '';
    $('p-note').value = (profile && profile.note) || '';
    $('p-total').value = limits.limitTotalBytes ? +(limits.limitTotalBytes / GB).toFixed(2) : '';
    $('p-daily').value = limits.limitDailyBytes ? +(limits.limitDailyBytes / GB).toFixed(2) : '';
    $('p-down').value = limits.downSpeedKbps !== undefined ? limits.downSpeedKbps : '';
    $('p-up').value = limits.upSpeedKbps !== undefined ? limits.upSpeedKbps : '';
    $('p-devices').value = limits.maxDevices !== undefined ? limits.maxDevices : '';
    $('p-days').value = (profile && profile.validDays) || '';

    setSettingsState((profile && profile.settings) || null);
    $('profile-delete').hidden = !profile;
    renderProfileSelects();
    $('profile-modal').hidden = false;
}

function setSettingsState(settings) {
    pendingSettings = settings;
    $('p-settings-state').textContent = settings
        ? `${Object.keys(settings).length} proxy settings stored in this profile.`
        : 'No proxy settings stored in this profile.';
}

$('p-grab').addEventListener('click', async () => {
    const panel = panelOfId($('p-source').value);
    if (!panel) {
        toast('Choose a panel to copy from.');
        return;
    }

    try {
        const body = await manage('read-settings', { panel });
        setSettingsState(body.settings || {});
        toast('Proxy settings copied into the profile.');
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('p-clear').addEventListener('click', () => {
    setSettingsState(null);
    toast('Proxy settings removed from the profile.');
});

$('profile-save').addEventListener('click', async () => {
    const name = $('p-name').value.trim();
    if (!name) {
        toast('Give the profile a name.');
        return;
    }

    // An empty field means "leave this alone on the target panel", so blanks
    // are dropped rather than sent as zero.
    const limits = {};
    const num = (id, key, factor = 1) => {
        const raw = $(id).value.trim();
        if (raw === '') return;
        const value = Math.round(parseFloat(raw) * factor);
        if (Number.isFinite(value) && value >= 0) limits[key] = value;
    };

    num('p-total', 'limitTotalBytes', GB);
    num('p-daily', 'limitDailyBytes', GB);
    num('p-down', 'downSpeedKbps');
    num('p-up', 'upSpeedKbps');
    num('p-devices', 'maxDevices');

    const validDays = $('p-days').value.trim();

    try {
        await manage('profile-save', {
            profile: {
                id: currentProfile ? currentProfile.id : undefined,
                name,
                note: $('p-note').value.trim(),
                limits: Object.keys(limits).length ? limits : null,
                settings: pendingSettings,
                validDays: validDays === '' ? undefined : Number(validDays)
            }
        });

        toast('Profile saved.');
        $('profile-modal').hidden = true;
        await loadProfiles();
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('profile-delete').addEventListener('click', async () => {
    if (!currentProfile) return;
    if (!confirm(`Delete the profile "${currentProfile.name}"?`)) return;

    try {
        await manage('profile-delete', { id: currentProfile.id });
        toast('Profile deleted.');
        $('profile-modal').hidden = true;
        await loadProfiles();
    } catch (error) {
        toast(String(error.message || error));
    }
});

/** Turns "valid for N days" into a concrete expiry at the moment of applying. */
function profileForApply(profile) {
    const limits = { ...(profile.limits || {}) };
    if (profile.validDays) limits.expireAt = Date.now() + profile.validDays * DAY;

    return {
        name: profile.name,
        limits: Object.keys(limits).length ? limits : null,
        settings: profile.settings || null
    };
}

/* ----------------------------------------------------------------- export */

$('export').addEventListener('click', async () => {
    const rows = [['name', 'display name', 'status', 'used bytes', 'quota bytes', 'expires', 'portal']];

    filtered.forEach(panel => {
        const detail = details.get(cardId(panel)) || {};
        const limits = detail.limits || {};
        const usage = detail.usage || {};

        rows.push([
            panel.name,
            limits.displayName || '',
            detail.status || '',
            String(usage.totalBytes || 0),
            String(limits.limitTotalBytes || 0),
            limits.expireAt ? new Date(limits.expireAt).toISOString().split('T')[0] : '',
            detail.portalUrl || ''
        ]);
    });

    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');

    try {
        await navigator.clipboard.writeText(csv);
        toast(`${rows.length - 1} rows copied as CSV — paste into a spreadsheet.`);
    } catch (error) {
        toast('Could not copy the CSV.');
    }
});

/* ------------------------------------------------------------- navigation */

$('search').addEventListener('input', applyFilter);
$('sort').addEventListener('change', applyFilter);

$('refresh').addEventListener('click', async () => {
    await loadPanels();
    await Promise.all([loadProfiles(), loadAccountUsage()]);
});

$('prev').addEventListener('click', () => { if (page > 0) { page--; renderPage(); } });
$('next').addEventListener('click', () => {
    if ((page + 1) * PAGE_SIZE < filtered.length) { page++; renderPage(); }
});
