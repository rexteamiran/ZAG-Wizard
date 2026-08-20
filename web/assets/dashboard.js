/* ==========================================================================
   ZAGROOO Wizard dashboard

   Every request goes through /api/manage/*, which does the Cloudflare work
   server side. Credentials live in memory for the session only: either the
   `key` from a private install link, or a token typed in here.
   ========================================================================== */

const GB = 1024 ** 3;
const PAGE_SIZE = 12;

const credential = {};
let panels = [];
let filtered = [];
let details = new Map();
let page = 0;
let current = null;

const $ = id => document.getElementById(id);

/* -------------------------------------------------------------- transport */

async function manage(action, payload = {}) {
    // The local edition swaps in a browser-side Cloudflare client under the
    // same signature, so everything below this line is shared.
    if (window.ZAG_MANAGE) return window.ZAG_MANAGE(action, { ...credential, ...payload });

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

let toastTimer = 0;

function toast(message) {
    const node = $('toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 2400);
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
        $('panels-section').hidden = false;
        await loadPanels();
    } catch (error) {
        toast(String(error.message || error));
    }
}

/* ---------------------------------------------------------------- listing */

async function loadPanels() {
    $('panels').innerHTML = '<div class="empty">Loading panels…</div>';

    try {
        const body = await manage('panels');
        panels = body.panels || [];
        details = new Map();
        applyFilter();
    } catch (error) {
        $('panels').innerHTML = `<div class="empty">${error.message || error}</div>`;
    }
}

function applyFilter() {
    const query = $('search').value.trim().toLowerCase();
    filtered = query ? panels.filter(panel => panel.name.toLowerCase().includes(query)) : panels;
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

    if (!slice.length) {
        $('panels').innerHTML = '<div class="empty">No ZAGROOO panels found on this account.</div>';
        return;
    }

    $('panels').innerHTML = slice.map(cardMarkup).join('');

    // Stats are fetched lazily so a hundred panels do not mean a hundred
    // blocking round trips before anything renders.
    slice.forEach(panel => loadDetail(panel));
}

function cardMarkup(panel) {
    const id = cardId(panel);
    return `<article class="panel-card" id="${id}">
        <div class="panel-card-head">
            <div>
                <strong>${panel.name}</strong>
                <span class="panel-meta">${panel.deployType}${panel.hasD1 ? ' · D1' : ' · KV'}</span>
            </div>
            <span class="pill is-muted" data-role="status">loading</span>
        </div>
        <div class="usage-line"><span>Total</span><b data-role="total">—</b></div>
        <div class="track"><span class="bar" data-role="bar"></span></div>
        <div class="usage-line"><span>Today</span><b data-role="daily">—</b></div>
        <div class="panel-links" data-role="links"></div>
    </article>`;
}

function cardId(panel) {
    return `panel-${panel.deployType}-${panel.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
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

    const status = card.querySelector('[data-role="status"]');
    status.textContent = detail.status;
    status.className = pillClass(detail.status);

    card.querySelector('[data-role="total"]').textContent = limits.limitTotalBytes
        ? `${fmtBytes(total)} / ${fmtBytes(limits.limitTotalBytes)}`
        : fmtBytes(total);
    card.querySelector('[data-role="daily"]').textContent = limits.limitDailyBytes
        ? `${fmtBytes(usage.dailyBytes || 0)} / ${fmtBytes(limits.limitDailyBytes)}`
        : fmtBytes(usage.dailyBytes || 0);

    const bar = card.querySelector('[data-role="bar"]');
    bar.style.width = `${pct}%`;
    bar.className = barClass(pct);

    const links = [`<button type="button" data-edit="${cardId(panel)}">Manage</button>`];
    if (detail.panelUrl) links.push(`<a href="${detail.panelUrl}" target="_blank" rel="noopener">Panel ↗</a>`);
    if (detail.portalUrl) {
        links.push(`<a href="${detail.portalUrl}" target="_blank" rel="noopener">Portal ↗</a>`);
        links.push(`<button type="button" data-copy="${detail.portalUrl}">Copy portal</button>`);
    }
    if (detail.error) links.push(`<span class="small">${detail.error}</span>`);

    card.querySelector('[data-role="links"]').innerHTML = links.join('');
}

/* ------------------------------------------------------------------ modal */

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

    const editBtn = event.target.closest('[data-edit]');
    if (editBtn) {
        openEditor(editBtn.dataset.edit);
        return;
    }

    if (event.target.closest('#edit-close') || event.target.id === 'edit-modal') {
        $('edit-modal').hidden = true;
        return;
    }

    const planBtn = event.target.closest('[data-plan]');
    if (planBtn) {
        const [days, gb, speed] = planBtn.dataset.plan.split(':').map(Number);
        $('f-total').value = gb;
        $('f-down').value = speed;
        $('f-expiry').value = days
            ? new Date(Date.now() + days * 86400000).toISOString().split('T')[0]
            : '';
    }
});

function openEditor(id) {
    const detail = details.get(id);
    if (!detail) return;

    current = detail;
    const limits = detail.limits || {};

    $('edit-title').textContent = `${detail.name} · ${detail.host || detail.deployType}`;
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
    $('f-expiry').value = limits.expireAt ? new Date(limits.expireAt).toISOString().split('T')[0] : '';
    $('edit-pause').textContent = limits.isPaused ? 'Resume' : 'Pause';

    $('edit-modal').hidden = false;
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

$('edit-save').addEventListener('click', async () => {
    if (!current) return;
    const expiry = $('f-expiry').value;

    const patch = {
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
        // End of the chosen day, so an expiry set to today still works today.
        expireAt: expiry ? new Date(`${expiry}T23:59:59Z`).getTime() : 0
    };

    await runAction('limits', { panel: panelRef(current), patch }, 'Limits saved.');
});

$('edit-pause').addEventListener('click', async () => {
    if (!current) return;
    const paused = !(current.limits && current.limits.isPaused);
    await runAction('pause', { panel: panelRef(current), paused }, paused ? 'Panel paused.' : 'Panel resumed.');
});

$('edit-reset').addEventListener('click', async () => {
    if (!current) return;
    if (!confirm(`Reset all usage counters for ${current.name}? This cannot be undone.`)) return;
    await runAction('reset-usage', { panel: panelRef(current), scope: 'all' }, 'Usage reset.');
});

$('edit-delete').addEventListener('click', async () => {
    if (!current) return;
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
    try {
        await manage(action, payload);
        toast(okMessage);
        const refreshed = await manage('detail', { panel: panelRef(current) });
        details.set(cardId(current), refreshed);
        current = refreshed;
        paintDetail(current, refreshed);
        $('edit-pause').textContent = refreshed.limits && refreshed.limits.isPaused ? 'Resume' : 'Pause';
    } catch (error) {
        toast(String(error.message || error));
    }
}

/* ------------------------------------------------------------- navigation */

$('search').addEventListener('input', applyFilter);
$('refresh').addEventListener('click', loadPanels);
$('prev').addEventListener('click', () => { if (page > 0) { page--; renderPage(); } });
$('next').addEventListener('click', () => {
    if ((page + 1) * PAGE_SIZE < filtered.length) { page++; renderPage(); }
});
