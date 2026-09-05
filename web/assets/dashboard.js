/* ==========================================================================
   ZAGROOO Wizard dashboard

   Panels are added on the API tab with a panel address and an API key. The
   browser then talks to each panel's API directly — the panel serves CORS
   headers for exactly this. Profiles live server-side, scoped to the signed-in
   user.
   ========================================================================== */

const GB = 1024 ** 3;
const PAGE_SIZE = 12;
const DAY = 86400000;

let connections = [];
let details = new Map();
let selected = new Set();
let profiles = [];
let page = 0;
let current = null;
let currentProfile = null;
let currentConnection = null;
let pendingSettings = null;

const $ = id => document.getElementById(id);

/* -------------------------------------------------------------- transport */

async function wizardApi(route, payload = {}) {
    const res = await fetch(`/api/${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.message || `Request failed (${res.status})`);
    return data.body ?? {};
}

/** Calls a panel's API straight from the browser with its own key. */
async function panelApi(connection, path, options = {}) {
    const res = await fetch(`${connection.api_url}/${path}`, {
        ...options,
        headers: {
            'Authorization': `Bearer ${connection.api_key}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers ?? {})
        }
    });

    const data = await res.json().catch(() => null);
    if (!data || data.success === false) {
        throw new Error(data?.message || `Panel returned ${res.status}`);
    }
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

(async function boot() {
    try {
        const me = await wizardApi('me');
        $('account').textContent = me.email;

        await loadProfiles();
        await loadConnections();
    } catch (error) {
        location.href = '/login';
    }
})();

$('logout').addEventListener('click', async () => {
    await wizardApi('auth/logout').catch(() => null);
    location.href = '/login';
});

/* ------------------------------------------------------------------ tabs */

$('tabs').addEventListener('click', event => {
    const tab = event.target.closest('.tab');
    if (!tab) return;

    document.querySelectorAll('#tabs .tab').forEach(node => node.classList.remove('is-active'));
    tab.classList.add('is-active');

    $('api-section').hidden = tab.dataset.tab !== 'api';
    $('zagiro-section').hidden = tab.dataset.tab !== 'zagiro';
    $('templates-section').hidden = tab.dataset.tab !== 'templates';
});

/* ----------------------------------------------------------- connections */

async function loadConnections() {
    $('panels').innerHTML = '<div class="empty">Loading panels…</div>';

    try {
        const body = await wizardApi('connections');
        connections = body.connections || [];
        details = new Map();
        selected = new Set();
        applyFilter();
        renderProfileSelects();
    } catch (error) {
        $('panels').innerHTML = `<div class="empty">${error.message || error}</div>`;
    }
}

function connId(connection) {
    return `conn-${connection.id}`;
}

function connectionOfId(id) {
    return connections.find(connection => connId(connection) === id);
}

/* ------------------------------------------------------------- add panel */

$('conn-add').addEventListener('click', () => {
    $('conn-title').textContent = 'Add a panel';
    $('c-label').value = '';
    $('c-url').value = '';
    $('c-key').value = '';
    $('conn-status').textContent = '';
    $('conn-modal').hidden = false;
});

$('conn-close').addEventListener('click', () => {
    $('conn-modal').hidden = true;
});

$('conn-save').addEventListener('click', async () => {
    const payload = {
        label: $('c-label').value.trim(),
        apiUrl: $('c-url').value.trim(),
        apiKey: $('c-key').value.trim()
    };

    if (!payload.label || !payload.apiUrl || !payload.apiKey) {
        $('conn-status').textContent = 'Fill in every field.';
        return;
    }

    $('conn-status').textContent = 'Testing the connection…';

    try {
        // Prove the key works against this exact panel before saving it.
        const probe = await fetch(`${normaliseApiUrl(payload.apiUrl)}/status`, {
            headers: { 'Authorization': `Bearer ${payload.apiKey}` }
        });
        const data = await probe.json().catch(() => null);
        if (!data?.success) {
            $('conn-status').textContent = data?.message || `Panel returned ${probe.status}.`;
            return;
        }

        await wizardApi('connections/add', payload);
        $('conn-modal').hidden = true;
        toast('Panel connected.');
        await loadConnections();
    } catch (error) {
        $('conn-status').textContent = error.message || error;
    }
});

/** Mirrors the server-side normalisation so the probe hits the same URL. */
function normaliseApiUrl(raw) {
    let url = raw.trim().replace(/\/+$/, '');
    if (!/^https:\/\//i.test(url)) url = `https://${url}`;
    url = url.replace(/\/panel$/, '/api');
    if (!/\/api$/.test(url)) url = `${url}/api`;
    return url;
}

/* ------------------------------------------------------------- rendering */

function sortConnections(list) {
    const mode = $('sort').value;
    const detailOf = connection => details.get(connId(connection)) || {};
    const copy = [...list];

    if (mode === 'usage') {
        copy.sort((a, b) => ((detailOf(b).usage || {}).totalBytes || 0) - ((detailOf(a).usage || {}).totalBytes || 0));
    } else if (mode === 'expiry') {
        copy.sort((a, b) =>
            ((detailOf(a).limits || {}).expireAt || Infinity) - ((detailOf(b).limits || {}).expireAt || Infinity));
    } else if (mode === 'status') {
        const rank = connection => (detailOf(connection).status === 'active' ? 1 : 0);
        copy.sort((a, b) => rank(a) - rank(b));
    } else {
        copy.sort((a, b) => a.label.localeCompare(b.label));
    }

    return copy;
}

function applyFilter() {
    const query = $('search').value.trim().toLowerCase();
    const matches = query
        ? connections.filter(connection => {
            const detail = details.get(connId(connection)) || {};
            const name = ((detail.limits || {}).displayName || '').toLowerCase();
            return connection.label.toLowerCase().includes(query) || name.includes(query);
        })
        : connections;

    filtered = sortConnections(matches);

    // Selection never outlives its filter — a bulk action can only hit what
    // the operator can see.
    const visible = new Set(filtered.map(connId));
    selected = new Set([...selected].filter(id => visible.has(id)));

    page = 0;
    renderPage();
}

let filtered = [];

function renderPage() {
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(page, totalPages - 1);

    const slice = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    $('count').textContent = `${filtered.length} panel${filtered.length === 1 ? '' : 's'}`;
    $('pager').hidden = totalPages < 2;
    $('page-label').textContent = `Page ${page + 1} of ${totalPages}`;
    $('bulkbar').hidden = filtered.length === 0;

    if (!slice.length) {
        $('panels').innerHTML = '<div class="empty">No panels yet — add one with “Add panel”, or install from the wizard’s front page.</div>';
        return;
    }

    $('panels').innerHTML = slice.map(cardMarkup).join('');
    updateSelectionUi();

    // Details load lazily, so fifty panels do not mean fifty blocking calls.
    slice.forEach(connection => {
        const cached = details.get(connId(connection));
        if (cached) paintDetail(connection, cached); else loadDetail(connection);
    });
}

function cardMarkup(connection) {
    const id = connId(connection);
    return `<article class="panel-card" id="${id}">
        <div class="panel-card-head">
            <label class="check-inline">
                <input type="checkbox" class="select-panel" data-id="${id}" ${selected.has(id) ? 'checked' : ''} />
                <span>
                    <strong data-role="title">${connection.label}</strong>
                    <span class="panel-meta" data-role="meta"></span>
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

async function loadDetail(connection) {
    try {
        const body = await panelApi(connection, 'status');
        const detail = {
            name: connection.label,
            connection,
            status: body.status || 'unknown',
            limits: body.limits || {},
            usage: {
                totalBytes: (body.usage || {}).total ?? 0,
                dailyBytes: (body.usage || {}).daily ?? 0
            },
            panelUrl: body.panel?.host ? `https://${body.panel.host}` : ''
        };

        details.set(connId(connection), detail);
        paintDetail(connection, detail);
    } catch (error) {
        const detail = {
            name: connection.label,
            connection,
            status: 'unknown',
            limits: {},
            usage: {},
            error: error.message || String(error)
        };

        details.set(connId(connection), detail);
        paintDetail(connection, detail);
    }
}

function paintDetail(connection, detail) {
    const card = document.getElementById(connId(connection));
    if (!card) return;

    const limits = detail.limits || {};
    const usage = detail.usage || {};
    const total = usage.totalBytes || 0;
    const pct = limits.limitTotalBytes ? Math.min(100, (total / limits.limitTotalBytes) * 100) : 0;

    if (limits.displayName) {
        card.querySelector('[data-role="title"]').textContent = `${limits.displayName} · ${connection.label}`;
    }

    card.querySelector('[data-role="meta"]').textContent = limits.zagiroName ? ` · ${limits.zagiroName}` : '';

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

    const host = detail.panelUrl;
    const links = [`<button type="button" data-edit="${connId(connection)}">Manage</button>`];

    if (host) {
        links.push(`<a href="${host}" target="_blank" rel="noopener">Panel ↗</a>`);
    }

    if (detail.error) links.push(`<span class="small">${detail.error}</span>`);

    card.querySelector('[data-role="links"]').innerHTML = links.join('');
}

/* ------------------------------------------------------------- selection */

function updateSelectionUi() {
    const total = filtered.length;
    $('selected-count').textContent = selected.size === total && total > 0
        ? `all ${total} selected`
        : `${selected.size} selected`;

    $('select-all').checked = total > 0 && selected.size === total;
}

document.addEventListener('change', event => {
    if (event.target.classList.contains('select-panel')) {
        const id = event.target.dataset.id;
        if (event.target.checked) selected.add(id); else selected.delete(id);
        updateSelectionUi();
        return;
    }

    if (event.target.id === 'select-all') {
        if (event.target.checked) {
            filtered.forEach(connection => selected.add(connId(connection)));
        } else {
            selected.clear();
        }

        document.querySelectorAll('.select-panel').forEach(box => {
            box.checked = event.target.checked;
        });

        updateSelectionUi();
    }
});

function selectedConnections() {
    const visible = new Map(filtered.map(connection => [connId(connection), connection]));
    return [...selected].map(id => visible.get(id)).filter(Boolean);
}

/* ---------------------------------------------------------------- editor */

document.addEventListener('click', async event => {
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

function openEditor(id) {
    const detail = details.get(id);
    if (!detail) return;

    current = detail;
    currentConnection = detail.connection;
    const limits = detail.limits || {};

    $('edit-title').textContent =
        `${limits.displayName ? limits.displayName + ' · ' : ''}${detail.name}`;
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

$('edit-save').addEventListener('click', async () => {
    if (!currentConnection) return;
    try {
        await panelApi(currentConnection, 'limits', {
            method: 'PATCH',
            body: JSON.stringify(limitsFromForm())
        });
        toast('Limits saved.');
        await refreshCurrent();
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('edit-pause').addEventListener('click', async () => {
    if (!currentConnection) return;
    const paused = !(current.limits && current.limits.isPaused);
    try {
        await panelApi(currentConnection, paused ? 'pause' : 'resume', {
            method: 'POST',
            body: JSON.stringify({})
        });
        toast(paused ? 'Panel paused.' : 'Panel resumed.');
        await refreshCurrent();
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('edit-reset').addEventListener('click', async () => {
    if (!currentConnection) return;
    if (!confirm(`Reset all usage counters for ${current.name}? This cannot be undone.`)) return;

    try {
        await panelApi(currentConnection, 'reset-usage', {
            method: 'POST',
            body: JSON.stringify({ scope: 'all' })
        });
        toast('Usage reset.');
        await refreshCurrent();
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('edit-update').addEventListener('click', async () => {
    if (!currentConnection) return;
    if (!confirm(`Update ${current.name} to the latest release? The panel redeploys itself and is back in a few seconds.`)) return;

    try {
        await panelApi(currentConnection, 'update', { method: 'POST', body: JSON.stringify({}) });
        toast('Panel updated.');
        await refreshCurrent();
    } catch (error) {
        toast(String(error.message || error));
    }
});

$('edit-forget').addEventListener('click', async () => {
    if (!currentConnection) return;
    if (!confirm(`Remove ${current.name} from this dashboard? The panel itself is NOT deleted — it keeps running.`)) return;

    try {
        await wizardApi('connections/delete', { id: currentConnection.id });
        toast('Connection removed.');
        $('edit-modal').hidden = true;
        await loadConnections();
    } catch (error) {
        toast(String(error.message || error));
    }
});

async function refreshCurrent() {
    if (!currentConnection) return;
    current = null;
    await loadDetail(currentConnection);
    const refreshed = details.get(connId(currentConnection));
    current = refreshed;
    currentConnection = refreshed.connection;
    $('edit-pause').textContent = (refreshed.limits || {}).isPaused ? 'Resume' : 'Pause';
}

/* ---------------------------------------------------------- bulk actions */

async function bulk(label, worker, { staged = false } = {}) {
    const targets = selectedConnections();
    if (!targets.length) {
        toast('Select some panels first.');
        return;
    }

    if (!confirm(`${label} ${targets.length} panel(s)?`)) return;

    let done = 0;
    const failures = [];

    for (const connection of targets) {
        try {
            await worker(connection);
            done++;

            // Staged: prove the first one survived before touching the rest,
            // so a bad release cannot take every customer down at once.
            if (staged && done === 1 && targets.length > 1) {
                const health = await panelApi(connection, 'status')
                    .then(() => ({ ok: true }))
                    .catch(error => ({ ok: false, detail: error.message }));

                if (!health.ok) {
                    failures.push(`${connection.label} unhealthy after the change (${health.detail}) — stopped here`);
                    break;
                }

                toast(`First panel healthy, continuing with ${targets.length - 1} more…`);
            }
        } catch (error) {
            failures.push(`${connection.label}: ${error.message || error}`);
        }
    }

    toast(failures.length ? `${done} done, ${failures.length} failed. ${failures[0]}` : `${label}: ${done} done.`);
    await loadConnections();
}

$('bulk-apply').addEventListener('click', () => {
    const profile = profiles.find(p => p.id === $('bulk-profile').value);
    if (!profile) {
        toast('Choose a profile first.');
        return;
    }

    bulk(`Apply "${profile.name}" to`, async connection => {
        const payload = profileForApply(profile);

        if (payload.limits && Object.keys(payload.limits).length) {
            await panelApi(connection, 'limits', {
                method: 'PATCH',
                body: JSON.stringify({ ...payload.limits, zagiroName: payload.name })
            });
        }

        if (payload.settings && Object.keys(payload.settings).length) {
            await panelApi(connection, 'settings', {
                method: 'PUT',
                body: JSON.stringify({ settings: payload.settings })
            });
        }
    });
});

$('bulk-update').addEventListener('click', () =>
    bulk('Update', connection => panelApi(connection, 'update', { method: 'POST', body: JSON.stringify({}) }), { staged: true }));

$('bulk-pause').addEventListener('click', () =>
    bulk('Pause', connection => panelApi(connection, 'pause', { method: 'POST', body: JSON.stringify({}) })));

$('bulk-resume').addEventListener('click', () =>
    bulk('Resume', connection => panelApi(connection, 'resume', { method: 'POST', body: JSON.stringify({}) })));

$('bulk-health').addEventListener('click', async () => {
    const targets = selectedConnections();
    if (!targets.length) {
        toast('Select some panels first.');
        return;
    }

    const results = await Promise.all(targets.map(async connection => {
        const health = await panelApi(connection, 'status')
            .then(() => true)
            .catch(() => false);
        return { connection, health };
    }));

    const bad = results.filter(result => !result.health);
    toast(bad.length
        ? `${bad.length} unreachable: ${bad.map(result => result.connection.label).join(', ')}`
        : `All ${results.length} panels reachable.`);
});

/* -------------------------------------------------------------- ZagiRo UI */

async function loadProfiles() {
    try {
        const body = await wizardApi('profiles');
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
                        <strong>${escapeHtml(profile.name)}</strong>
                        <span class="panel-meta">${escapeHtml(profile.note || 'No note')}</span>
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
        .concat(profiles.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`))
        .join('');

    $('p-source').innerHTML = ['<option value="">Copy proxy settings from a panel…</option>']
        .concat(connections.map(p => `<option value="${connId(p)}">${escapeHtml(p.label)}</option>`))
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
    const connection = connectionOfId($('p-source').value);
    if (!connection) {
        toast('Choose a panel to copy from.');
        return;
    }

    try {
        const body = await panelApi(connection, 'settings');
        setSettingsState((body || {}).settings || {});
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
        await wizardApi('profiles/save', {
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
        await wizardApi('profiles/delete', { id: currentProfile.id });
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
    const button = $('export');
    const original = button.textContent;

    const missing = filtered.filter(connection => !details.has(connId(connection)));

    if (missing.length) {
        button.textContent = `Loading ${missing.length}…`;
        button.disabled = true;

        for (const connection of missing) {
            await loadDetail(connection);
        }

        button.textContent = original;
        button.disabled = false;
    }

    const rows = [['name', 'display name', 'status', 'used bytes', 'quota bytes', 'expires', 'panel']];
    let incomplete = 0;

    filtered.forEach(connection => {
        const detail = details.get(connId(connection));
        if (!detail) incomplete++;

        const limits = (detail || {}).limits || {};
        const usage = (detail || {}).usage || {};

        rows.push([
            connection.label,
            limits.displayName || '',
            (detail || {}).status || 'unknown',
            String(usage.totalBytes || 0),
            String(limits.limitTotalBytes || 0),
            limits.expireAt ? new Date(limits.expireAt).toISOString().split('T')[0] : '',
            detail?.panelUrl || ''
        ]);
    });

    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');

    try {
        const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = url;
        link.download = `zagrooo-panels-${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        toast(incomplete
            ? `Exported ${rows.length - 1} rows — ${incomplete} could not be read.`
            : `Exported ${rows.length - 1} rows.`);
    } catch (error) {
        try {
            await navigator.clipboard.writeText(csv);
            toast(`Download blocked — ${rows.length - 1} rows copied instead.`);
        } catch (copyError) {
            toast('Could not export the CSV.');
        }
    }
});

/* ------------------------------------------------------------- navigation */

$('search').addEventListener('input', applyFilter);
$('sort').addEventListener('change', applyFilter);

$('refresh').addEventListener('click', async () => {
    await loadConnections();
    await loadProfiles();
});

$('prev').addEventListener('click', () => { if (page > 0) { page--; renderPage(); } });
$('next').addEventListener('click', () => {
    if ((page + 1) * PAGE_SIZE < filtered.length) { page++; renderPage(); }
});

/* ==========================================================================
   Setting templates

   The same library the panel ships, vendored by scripts/sync-templates.mjs so
   this build never needs the network. Applying one PUTs its settings to each
   selected panel's API directly.
   ========================================================================== */

const TEMPLATES = window.ZAG_TEMPLATES || [];

function templateName(template) {
    return (template.name && (template.name.en || template.name.fa)) || template.id;
}

function templateDescription(template) {
    return (template.description && (template.description.en || template.description.fa)) || '';
}

function renderTemplates() {
    const family = $('template-family').value;
    const visible = family ? TEMPLATES.filter(t => t.family === family) : TEMPLATES;

    if (!visible.length) {
        $('templates').innerHTML = '<div class="empty">No templates in this family.</div>';
        return;
    }

    $('templates').innerHTML = visible.map(template => `
        <article class="panel-card">
            <div class="panel-card-head">
                <div>
                    <strong>${escapeHtml(templateName(template))}</strong>
                    <span class="panel-meta">${escapeHtml(template.family)}</span>
                </div>
            </div>
            <p class="muted small" style="margin:0">${escapeHtml(templateDescription(template))}</p>
            ${template.warning
        ? `<p class="muted small" style="margin:0">⚠️ ${escapeHtml(template.warning.en || template.warning.fa)}</p>`
        : ''}
            <div class="panel-links">
                <button type="button" data-apply-template="${template.id}">Apply to selected</button>
                <button type="button" data-save-template="${template.id}">Save as profile</button>
            </div>
        </article>
    `).join('');
}

/** Operator-authored text goes through innerHTML, so escape it. */
function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
}

$('template-family').addEventListener('change', renderTemplates);

document.addEventListener('click', async event => {
    const applyBtn = event.target.closest('[data-apply-template]');
    if (applyBtn) {
        const template = TEMPLATES.find(t => t.id === applyBtn.dataset.applyTemplate);
        if (!template) return;

        if (template.warning) {
            const proceed = confirm(`${templateName(template)}\n\n${template.warning.en || template.warning.fa}\n\nApply anyway?`);
            if (!proceed) return;
        }

        bulk(`Apply "${templateName(template)}" to`, connection =>
            panelApi(connection, 'settings', {
                method: 'PUT',
                body: JSON.stringify({ settings: template.settings })
            }));

        return;
    }

    const saveBtn = event.target.closest('[data-save-template]');
    if (saveBtn) {
        const template = TEMPLATES.find(t => t.id === saveBtn.dataset.saveTemplate);
        if (!template) return;

        try {
            await wizardApi('profiles/save', {
                profile: {
                    name: templateName(template),
                    note: templateDescription(template).slice(0, 200),
                    settings: template.settings,
                    limits: null
                }
            });

            toast(`Saved "${templateName(template)}" as a profile — add quotas to it on the ZagiRo tab.`);
            await loadProfiles();
        } catch (error) {
            toast(String(error.message || error));
        }
    }
});

renderTemplates();
