/* ==========================================================================
   ZAGROOO local wizard — browser-side Cloudflare client

   The hosted dashboard posts to /api/manage/* and the worker does the
   Cloudflare work. The local edition has no worker, so this file implements
   the same actions against the Cloudflare API and exposes them as
   window.ZAG_MANAGE, which dashboard.js prefers when present.

   Requests go through the same-origin /cf/* proxy that scripts/local-server.mjs
   provides. They cannot go direct: the Cloudflare API sends no CORS headers on
   token-authenticated requests, so the browser blocks them.

   The token stays in this page's memory and in the local server process. It is
   never persisted, but it is a full-access credential for your Cloudflare
   account — use a token scoped to Workers, KV, D1 and Pages, never a Global API
   Key, and close the tab when you are done.
   ========================================================================== */

(function () {
    // api.cloudflare.com sends no CORS headers for token-authenticated calls,
    // so the browser cannot talk to it directly. The local server sets
    // ZAG_CF_PROXY to its own same-origin proxy path; the direct URL is only a
    // fallback for a host that does allow the cross-origin call.
    const API = window.ZAG_CF_PROXY || 'https://api.cloudflare.com/client/v4';

    const state = { token: '', accountId: '' };

    async function call(path, init = {}) {
        const res = await fetch(`${API}${path}`, {
            ...init,
            headers: {
                'Authorization': `Bearer ${state.token}`,
                ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers || {})
            }
        });

        const data = await res.json();
        if (!res.ok || data.success === false) {
            throw new Error((data.errors && data.errors[0] && data.errors[0].message) || `HTTP ${res.status}`);
        }

        return data.result;
    }

    const acct = (path, init) => call(`/accounts/${state.accountId}${path}`, init);

    /* ------------------------------------------------------------ account */

    async function connect(token) {
        state.token = token;

        const verify = await call('/user/tokens/verify');
        if (verify.status !== 'active') throw new Error(`API token is ${verify.status}.`);

        const accounts = await call('/accounts');
        if (!accounts.length) throw new Error('This token has no account access.');
        state.accountId = accounts[0].id;

        const user = await call('/user');
        return { email: (user.email || '').toLowerCase(), id: state.accountId };
    }

    /* ------------------------------------------------------------ listing */

    async function workerBindings(name) {
        const settings = await acct(`/workers/scripts/${encodeURIComponent(name)}/settings`);
        return (settings && settings.bindings) || [];
    }

    async function listPanels() {
        const [scripts, projects] = await Promise.all([
            acct('/workers/scripts').catch(() => []),
            acct('/pages/projects').catch(() => [])
        ]);

        const workers = await Promise.all((scripts || []).map(async script => {
            const bindings = await workerBindings(script.id).catch(() => []);
            return {
                name: script.id,
                deployType: 'workers',
                modifiedOn: script.modified_on || '',
                hasKv: bindings.some(b => b.name === 'kv'),
                hasD1: bindings.some(b => b.name === 'zag_db')
            };
        }));

        const pages = (projects || []).map(project => {
            const config = (project.deployment_configs && project.deployment_configs.production) || {};
            return {
                name: project.name,
                deployType: 'pages',
                modifiedOn: (project.latest_deployment && project.latest_deployment.modified_on) || project.created_on || '',
                hasKv: Boolean(config.kv_namespaces && config.kv_namespaces.kv),
                hasD1: Boolean(config.d1_databases && config.d1_databases.zag_db)
            };
        });

        return [...workers, ...pages].filter(panel => panel.hasKv);
    }

    async function bindingsOf(panel) {
        if (panel.deployType === 'pages') {
            const project = await acct(`/pages/projects/${encodeURIComponent(panel.name)}`);
            const config = (project.deployment_configs && project.deployment_configs.production) || {};
            return {
                kvNamespaceId: (config.kv_namespaces && config.kv_namespaces.kv && config.kv_namespaces.kv.namespace_id) || '',
                d1DatabaseId: (config.d1_databases && config.d1_databases.zag_db && config.d1_databases.zag_db.id) || ''
            };
        }

        const bindings = await workerBindings(panel.name);
        const kv = bindings.find(b => b.name === 'kv');
        const d1 = bindings.find(b => b.name === 'zag_db');
        return {
            kvNamespaceId: (kv && kv.namespace_id) || '',
            d1DatabaseId: (d1 && d1.id) || ''
        };
    }

    /* ------------------------------------------------------------- stores */

    async function d1Query(databaseId, sql, params = []) {
        const result = await acct(`/d1/database/${databaseId}/query`, {
            method: 'POST',
            body: JSON.stringify({ sql, params })
        });

        return (result && result[0] && result[0].results) || [];
    }

    async function kvGet(namespaceId, key) {
        const res = await fetch(
            `${API}/accounts/${state.accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
            { headers: { 'Authorization': `Bearer ${state.token}` } }
        );

        if (!res.ok) return null;
        return await res.json().catch(() => null);
    }

    async function kvPut(namespaceId, key, value) {
        const form = new FormData();
        form.append('value', JSON.stringify(value));
        form.append('metadata', '{}');

        const res = await fetch(
            `${API}/accounts/${state.accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
            { method: 'PUT', headers: { 'Authorization': `Bearer ${state.token}` }, body: form }
        );

        if (!res.ok) throw new Error(`KV write failed: HTTP ${res.status}`);
    }

    async function storeGet(binding, key) {
        if (binding.d1DatabaseId) {
            try {
                const rows = await d1Query(binding.d1DatabaseId, 'SELECT value FROM zag_store WHERE key = ?', [key]);
                if (rows.length) return JSON.parse(rows[0].value);
            } catch (error) {
                // Table missing or key absent — fall through to KV.
            }
        }

        return binding.kvNamespaceId ? await kvGet(binding.kvNamespaceId, key) : null;
    }

    async function storePut(binding, key, value) {
        if (binding.d1DatabaseId) {
            await d1Query(binding.d1DatabaseId, 'CREATE TABLE IF NOT EXISTS zag_store (key TEXT PRIMARY KEY, value TEXT)');
            await d1Query(
                binding.d1DatabaseId,
                'INSERT INTO zag_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                [key, JSON.stringify(value)]
            );
            return;
        }

        if (!binding.kvNamespaceId) throw new Error('Panel has no writable store.');
        await kvPut(binding.kvNamespaceId, key, value);
    }

    /* ------------------------------------------------------------- detail */

    async function embeddedSettings(panel) {
        if (panel.deployType === 'pages') {
            const project = await acct(`/pages/projects/${encodeURIComponent(panel.name)}`);
            return { mainDomain: project.subdomain || '' };
        }

        const res = await fetch(
            `${API}/accounts/${state.accountId}/workers/scripts/${encodeURIComponent(panel.name)}/content`,
            { headers: { 'Authorization': `Bearer ${state.token}` } }
        );

        if (!res.ok) return {};
        const source = await res.text();
        const match = source.match(/EMBEDED_SETTINGS\s*=\s*(\{[\s\S]*?\});/);
        if (!match) return {};

        try {
            return JSON.parse(match[1]);
        } catch (error) {
            return {};
        }
    }

    /* ------------------------------------------------------------ defaults */

    // A panel writes its own limits record the first time it runs. One that was
    // just installed and never opened has none, so the wizard seeds it, matching
    // the panel's own defaultLimits().
    function randomToken(bytes) {
        var buffer = new Uint8Array(bytes || 16);
        crypto.getRandomValues(buffer);
        return Array.from(buffer, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    }

    function defaultLimits() {
        return {
            displayName: '',
            subToken: randomToken(),
            limitTotalBytes: 0,
            limitDailyBytes: 0,
            downSpeedKbps: 0,
            upSpeedKbps: 0,
            expireAt: 0,
            maxDevices: 0,
            isPaused: false,
            pauseReason: '',
            pausedAt: 0,
            monthlyReset: false,
            monthlyResetDay: 1,
            alertQuota: false,
            alertExpiry: false,
            alertState: { quota80: false, quota100: false, expirySoon: false },
            panelApiKeys: []
        };
    }

    function describeStatus(limits, usage) {
        if (!limits) return 'unknown';
        if (limits.isPaused) return 'paused';
        if (limits.expireAt && Date.now() > limits.expireAt) return 'expired';

        const total = (usage && usage.totalBytes) || 0;
        const daily = (usage && usage.dailyBytes) || 0;
        if (limits.limitTotalBytes && total >= limits.limitTotalBytes) return 'limited';
        if (limits.limitDailyBytes && daily >= limits.limitDailyBytes) return 'daily-limited';
        return 'active';
    }

    async function panelDetail(panel) {
        const base = {
            ...panel,
            host: '', securePath: '', uuid: '',
            limits: null, usage: null, status: 'unknown',
            portalUrl: '', panelUrl: ''
        };

        try {
            const binding = await bindingsOf(panel);
            const [settings, limits, usage] = await Promise.all([
                embeddedSettings(panel),
                storeGet(binding, 'limits'),
                storeGet(binding, 'usage')
            ]);

            const host = settings.mainDomain || '';
            const securePath = settings.securePath || '';

            return {
                ...base,
                host,
                securePath,
                uuid: settings.vlUUID || '',
                limits,
                usage,
                status: describeStatus(limits, usage),
                panelUrl: host && securePath ? `https://${host}/${securePath}/panel` : '',
                portalUrl: host && securePath && limits && limits.subToken
                    ? `https://${host}/${securePath}/sub/${limits.subToken}`
                    : ''
            };
        } catch (error) {
            return { ...base, error: String(error.message || error) };
        }
    }

    /* ----------------------------------------------------------- mutation */

    function sanitise(patch) {
        const out = {};
        const numeric = ['limitTotalBytes', 'limitDailyBytes', 'downSpeedKbps', 'upSpeedKbps',
            'expireAt', 'maxDevices', 'monthlyResetDay'];

        numeric.forEach(field => {
            if (patch[field] === undefined) return;
            const value = Math.floor(Number(patch[field]));
            if (Number.isFinite(value) && value >= 0) out[field] = value;
        });

        if (patch.displayName !== undefined) out.displayName = String(patch.displayName).slice(0, 64);
        ['monthlyReset', 'alertQuota', 'alertExpiry', 'isPaused'].forEach(flag => {
            if (patch[flag] !== undefined) out[flag] = Boolean(patch[flag]);
        });

        return out;
    }

    async function updateLimits(panel, patch) {
        const binding = await bindingsOf(panel);
        const current = (await storeGet(binding, 'limits')) || defaultLimits();

        const next = { ...current, ...sanitise(patch) };
        const usage = await storeGet(binding, 'usage');

        // Raising a limit should revive a panel that was paused by hitting it.
        if (next.isPaused && patch.isPaused === undefined && describeStatus({ ...next, isPaused: false }, usage) === 'active') {
            next.isPaused = false;
            next.pauseReason = '';
            next.pausedAt = 0;
        }

        next.alertState = { quota80: false, quota100: false, expirySoon: false };
        await storePut(binding, 'limits', next);
        return { limits: next };
    }

    async function setPaused(panel, paused, reason) {
        const binding = await bindingsOf(panel);
        const current = (await storeGet(binding, 'limits')) || defaultLimits();

        await storePut(binding, 'limits', {
            ...current,
            isPaused: paused,
            pauseReason: paused ? (reason || 'Paused from the local wizard.') : '',
            pausedAt: paused ? Date.now() : 0
        });

        return {};
    }

    async function resetUsage(panel, scope) {
        const binding = await bindingsOf(panel);
        const current = await storeGet(binding, 'usage');
        const day = new Date().toISOString().split('T')[0];

        const next = scope === 'daily'
            ? { ...(current || {}), dailyBytes: 0, day, updatedAt: Date.now() }
            : {
                upBytes: 0, downBytes: 0, totalBytes: 0, dailyBytes: 0,
                day, lastMonthlyReset: day.slice(0, 7), history: [], updatedAt: Date.now()
            };

        await storePut(binding, 'usage', next);
        return {};
    }

    async function deletePanel(panel) {
        const path = panel.deployType === 'pages'
            ? `/pages/projects/${encodeURIComponent(panel.name)}`
            : `/workers/scripts/${encodeURIComponent(panel.name)}`;

        await acct(path, { method: 'DELETE' });
        return {};
    }

    /* ------------------------------------------------------------ dispatch */

    window.ZAG_MANAGE = async function (action, payload) {
        if (payload.key) {
            throw new Error('Private install links only work in the hosted wizard. Paste an API token here instead.');
        }

        if (action === 'account') return connect((payload.token || '').trim());
        if (!state.token) throw new Error('Not connected.');

        switch (action) {
            case 'panels':
                return { panels: await listPanels() };
            case 'detail':
                return await panelDetail(payload.panel);
            case 'limits':
                return await updateLimits(payload.panel, payload.patch || {});
            case 'pause':
                return await setPaused(payload.panel, payload.paused !== false, payload.reason);
            case 'reset-usage':
                return await resetUsage(payload.panel, payload.scope === 'daily' ? 'daily' : 'all');
            case 'delete':
                return await deletePanel(payload.panel);
            default:
                throw new Error(`Unknown action: ${action}`);
        }
    };
})();
