/* ==========================================================================
   ZAGROOO panel management

   The wizard holds the Cloudflare API token, so it reads and writes each
   panel's stores directly over the Cloudflare REST API. No panel API key
   exchange is needed, and a panel stays manageable even if its own admin
   login is lost.

   Panels are discovered by their bindings: every ZAGROOO panel has a KV
   namespace bound as `kv`, and (unless it predates D1 support) a database
   bound as `zag_db`.
   ========================================================================== */

import { defaultLimits, wizardKeyPair } from './seed';
import { parseEmbeddedSettings } from './embedded';

const API = 'https://api.cloudflare.com/client/v4';

export interface PanelBinding {
    kvNamespaceId: string;
    d1DatabaseId: string;
}

export interface PanelSummary {
    name: string;
    deployType: 'workers' | 'pages';
    modifiedOn: string;
    hasKv: boolean;
    hasD1: boolean;
    /** False when Cloudflare would not tell us this script's bindings. */
    readable?: boolean;
}

export interface PanelDetail extends PanelSummary {
    host: string;
    securePath: string;
    uuid: string;
    limits: Record<string, any> | null;
    usage: Record<string, any> | null;
    status: string;
    portalUrl: string;
    panelUrl: string;
    error?: string;
}

export class PanelManager {
    private readonly token: string;
    private readonly accountId: string;

    constructor(token: string, accountId: string) {
        this.token = token;
        this.accountId = accountId;
    }

    private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
        const res = await fetch(`${API}/accounts/${this.accountId}${path}`, {
            ...init,
            headers: {
                'Authorization': `Bearer ${this.token}`,
                ...(init.body ? { 'Content-Type': 'application/json' } : {}),
                ...(init.headers ?? {})
            }
        });

        const data = await res.json() as any;
        if (!res.ok || data.success === false) {
            const message = data?.errors?.[0]?.message ?? `HTTP ${res.status}`;
            throw new Error(message);
        }

        return data.result as T;
    }

    /* ---------------------------------------------------------------- list */

    async listPanels(): Promise<PanelSummary[]> {
        const [scripts, projects] = await Promise.all([
            this.call<any[]>('/workers/scripts').catch(() => []),
            this.call<any[]>('/pages/projects').catch(() => [])
        ]);

        // One settings lookup per script. A 429 here used to be swallowed to
        // [], which reported the panel as having no KV binding and dropped it
        // from the list silently — the operator just saw a shorter list.
        const failures: string[] = [];

        const workers = await Promise.all(
            (scripts ?? []).map(async script => {
                let bindings: any[] = [];
                let readable = true;

                try {
                    bindings = await this.workerBindings(script.id);
                } catch (error) {
                    readable = false;
                    failures.push(script.id);
                }

                return {
                    name: script.id,
                    deployType: 'workers' as const,
                    modifiedOn: script.modified_on ?? '',
                    hasKv: bindings.some(b => b.name === 'kv'),
                    hasD1: bindings.some(b => b.name === 'zag_db'),
                    readable
                };
            })
        );

        if (failures.length) {
            console.log(`Could not read bindings for: ${failures.join(', ')}`);
        }

        const pages = (projects ?? []).map(project => {
            const config = project.deployment_configs?.production ?? {};
            return {
                name: project.name,
                deployType: 'pages' as const,
                modifiedOn: project.latest_deployment?.modified_on ?? project.created_on ?? '',
                hasKv: Boolean(config.kv_namespaces?.kv),
                hasD1: Boolean(config.d1_databases?.zag_db),
                readable: true
            };
        });

        // A `kv` binding is what makes something a ZAGROOO panel rather than
        // some other worker. A script whose bindings could not be read is kept
        // and flagged, rather than disappearing as though it did not exist.
        return [...workers, ...pages].filter(panel => panel.hasKv || !panel.readable);
    }

    private async workerBindings(name: string): Promise<any[]> {
        const settings = await this.call<any>(`/workers/scripts/${encodeURIComponent(name)}/settings`);
        return settings?.bindings ?? [];
    }

    async bindingsOf(name: string, deployType: string): Promise<PanelBinding> {
        if (deployType === 'pages') {
            const project = await this.call<any>(`/pages/projects/${encodeURIComponent(name)}`);
            const config = project.deployment_configs?.production ?? {};
            return {
                kvNamespaceId: config.kv_namespaces?.kv?.namespace_id ?? '',
                d1DatabaseId: config.d1_databases?.zag_db?.id ?? ''
            };
        }

        const bindings = await this.workerBindings(name);
        return {
            kvNamespaceId: bindings.find(b => b.name === 'kv')?.namespace_id ?? '',
            d1DatabaseId: bindings.find(b => b.name === 'zag_db')?.id ?? ''
        };
    }

    /* -------------------------------------------------------------- stores */

    private async kvGet(namespaceId: string, key: string): Promise<any | null> {
        const res = await fetch(
            `${API}/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
            { headers: { 'Authorization': `Bearer ${this.token}` } }
        );

        if (!res.ok) return null;
        return await res.json().catch(() => null);
    }

    private async kvPut(namespaceId: string, key: string, value: unknown): Promise<void> {
        const form = new FormData();
        form.append('value', JSON.stringify(value));
        form.append('metadata', '{}');

        const res = await fetch(
            `${API}/accounts/${this.accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
            { method: 'PUT', headers: { 'Authorization': `Bearer ${this.token}` }, body: form }
        );

        if (!res.ok) throw new Error(`KV write failed: HTTP ${res.status}`);
    }

    private async d1Query(databaseId: string, sql: string, params: unknown[] = []): Promise<any[]> {
        const result = await this.call<any>(`/d1/database/${databaseId}/query`, {
            method: 'POST',
            body: JSON.stringify({ sql, params })
        });

        return result?.[0]?.results ?? [];
    }

    async storeGet(binding: PanelBinding, key: string): Promise<any | null> {
        if (binding.d1DatabaseId) {
            try {
                const rows = await this.d1Query(
                    binding.d1DatabaseId,
                    'SELECT value FROM zag_store WHERE key = ?',
                    [key]
                );

                if (rows.length) return JSON.parse(rows[0].value);
                // Table exists but the key is absent: the panel has not
                // written it yet, so fall through to KV in case this panel
                // was migrated from an older, KV-only build.
            } catch (error) {
                // Table missing entirely — same fall-through.
            }
        }

        return binding.kvNamespaceId ? await this.kvGet(binding.kvNamespaceId, key) : null;
    }

    async storePut(binding: PanelBinding, key: string, value: unknown): Promise<void> {
        if (binding.d1DatabaseId) {
            await this.d1Query(
                binding.d1DatabaseId,
                'CREATE TABLE IF NOT EXISTS zag_store (key TEXT PRIMARY KEY, value TEXT)'
            );
            await this.d1Query(
                binding.d1DatabaseId,
                'INSERT INTO zag_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                [key, JSON.stringify(value)]
            );
            return;
        }

        if (!binding.kvNamespaceId) throw new Error('Panel has no writable store.');
        await this.kvPut(binding.kvNamespaceId, key, value);
    }

    /* -------------------------------------------------------------- detail */

    /**
     * Reads the panel's embedded settings out of its deployed script. That is
     * the only place `securePath` lives, and it is what the portal and
     * subscription URLs are built from.
     */
    async embeddedSettings(name: string, deployType: string): Promise<Record<string, any>> {
        const path = deployType === 'pages'
            ? `/pages/projects/${encodeURIComponent(name)}`
            : `/workers/scripts/${encodeURIComponent(name)}/content`;

        if (deployType === 'pages') {
            // Pages does not expose the deployed _worker.js, so the host is
            // all we can recover; securePath comes from the stored limits.
            const project = await this.call<any>(path);
            return { mainDomain: project.subdomain ?? '' };
        }

        const res = await fetch(`${API}/accounts/${this.accountId}${path}`, {
            headers: { 'Authorization': `Bearer ${this.token}` }
        });

        if (!res.ok) return {};
        return parseEmbeddedSettings(await res.text());
    }

    async panelDetail(summary: PanelSummary): Promise<PanelDetail> {
        const base: PanelDetail = {
            ...summary,
            host: '',
            securePath: '',
            uuid: '',
            limits: null,
            usage: null,
            status: 'unknown',
            portalUrl: '',
            panelUrl: ''
        };

        try {
            const binding = await this.bindingsOf(summary.name, summary.deployType);
            const [settings, limits, usage] = await Promise.all([
                this.embeddedSettings(summary.name, summary.deployType),
                this.storeGet(binding, 'limits'),
                this.storeGet(binding, 'usage')
            ]);

            // Report what the account actually has, not what the caller sent.
            // Echoing the client's value left "Add D1" on screen after D1 was
            // attached, and the card still reading "KV" until a full refresh.
            base.hasD1 = Boolean(binding.d1DatabaseId);
            base.hasKv = Boolean(binding.kvNamespaceId);

            // The wizard records these at install time. Parsing the deployed
            // script is only a fallback for panels installed before that, and
            // it is exactly the step that used to fail and blank the links.
            const host = limits?.panelHost || settings.mainDomain || '';
            const securePath = limits?.panelPath || settings.securePath || '';

            return {
                ...base,
                hasD1: base.hasD1,
                hasKv: base.hasKv,
                host,
                securePath,
                uuid: settings.vlUUID ?? '',
                limits,
                usage,
                status: describeStatus(limits, usage),
                panelUrl: host && securePath ? `https://${host}/${securePath}/panel` : '',
                portalUrl: host && securePath && limits?.subToken
                    ? `https://${host}/${securePath}/sub/${limits.subToken}`
                    : ''
            };
        } catch (error) {
            return { ...base, error: String(error) };
        }
    }

    /* ------------------------------------------------------------- mutation */

    async updateLimits(summary: PanelSummary, patch: Record<string, unknown>): Promise<Record<string, any>> {
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        // Seed the record when the panel has never run, so a freshly installed
        // panel is configurable straight away.
        const current = (await this.storeGet(binding, 'limits')) ?? defaultLimits();

        const next = { ...current, ...sanitiseLimits(patch) };

        // Raising a limit should revive a panel that paused itself on hitting
        // it. describeStatus reports 'paused' whenever isPaused is set, so
        // asking it about `next` directly could only ever answer 'paused' —
        // the branch never ran and topped-up customers stayed dead. Ask what
        // the status would be with the pause lifted instead.
        const autoPaused = next.isPaused && next.pausedBy && next.pausedBy !== 'manual';
        if (autoPaused && patch.isPaused === undefined) {
            const usage = await this.storeGet(binding, 'usage');
            if (describeStatus({ ...next, isPaused: false }, usage) === 'active') {
                next.isPaused = false;
                next.pauseReason = '';
                next.pausedBy = '';
                next.pausedAt = 0;
            }
        }

        next.alertState = { quota80: false, quota100: false, expirySoon: false };
        await this.storePut(binding, 'limits', next);
        return next;
    }

    async setPaused(summary: PanelSummary, paused: boolean, reason = 'Paused from the wizard.'): Promise<void> {
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        const current = (await this.storeGet(binding, 'limits')) ?? defaultLimits();

        await this.storePut(binding, 'limits', {
            ...current,
            isPaused: paused,
            pauseReason: paused ? reason : '',
            pausedAt: paused ? Date.now() : 0
        });
    }

    async resetUsage(summary: PanelSummary, scope: 'all' | 'daily'): Promise<void> {
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        const current = await this.storeGet(binding, 'usage');
        const day = new Date().toISOString().split('T')[0];

        const next = scope === 'daily'
            ? { ...(current ?? {}), dailyBytes: 0, day, updatedAt: Date.now() }
            : {
                upBytes: 0,
                downBytes: 0,
                totalBytes: 0,
                dailyBytes: 0,
                day,
                lastMonthlyReset: day.slice(0, 7),
                history: [],
                updatedAt: Date.now()
            };

        await this.storePut(binding, 'usage', next);
    }

    /**
     * Recomputes where a panel lives and stores it, so the dashboard links
     * work for panels installed before the wizard recorded their address.
     */
    async repairPanel(summary: PanelSummary): Promise<{ host: string; securePath: string }> {
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        const settings = await this.embeddedSettings(summary.name, summary.deployType);
        const limits = (await this.storeGet(binding, 'limits')) ?? defaultLimits();

        // `??` keeps an empty string, and Pages reports mainDomain as '' when
        // the project has no subdomain — so repair threw even when the address
        // had been recorded correctly at install. panelDetail already uses `||`.
        let host = limits.panelHost || settings.mainDomain || '';
        const securePath = limits.panelPath || settings.securePath || '';

        // Pages reports only the project subdomain; workers need the account's
        // workers.dev subdomain prepended with the script name.
        if (!host && summary.deployType === 'workers') {
            const sub = await this.workersDevSubdomain();
            if (sub) host = `${summary.name}.${sub}`;
        }

        if (!host || !securePath) {
            throw new Error('Could not work out this panel\'s address. Open the panel once, then try again.');
        }

        await this.storePut(binding, 'limits', { ...limits, panelHost: host, panelPath: securePath });
        return { host, securePath };
    }

    private async workersDevSubdomain(): Promise<string> {
        try {
            const res = await this.call<any>('/workers/subdomain');
            return res?.subdomain ? `${res.subdomain}.workers.dev` : '';
        } catch (error) {
            return '';
        }
    }

    /**
     * Applies a ZagiRo profile. Proxy settings go through the panel's own
     * validation endpoint rather than being written raw, because the panel
     * derives fields (DNS resolution, proxy parameters) that a raw write
     * would skip and leave inconsistent.
     */
    async applyProfile(
        summary: PanelSummary,
        profile: { name?: string; settings?: Record<string, any> | null; limits?: Record<string, any> | null }
    ): Promise<{ settings: string; limits: string }> {
        const report = { settings: 'skipped', limits: 'skipped' };

        if (profile.limits && Object.keys(profile.limits).length) {
            await this.updateLimits(summary, { ...profile.limits, zagiroName: profile.name ?? '' });
            report.limits = 'applied';
        }

        if (profile.settings && Object.keys(profile.settings).length) {
            const detail = await this.panelDetail(summary);
            if (!detail.host || !detail.securePath) {
                report.settings = 'no address for this panel - run Repair first';
            } else {
                const key = await this.wizardKey(summary);
                const res = await fetch(`https://${detail.host}/${detail.securePath}/api/settings`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({ settings: profile.settings })
                });

                const data = await res.json().catch(() => null) as any;
                report.settings = data?.success
                    ? 'applied'
                    : `refused: ${data?.message ?? `HTTP ${res.status}`}`;
            }
        }

        // updateLimits already carries zagiroName when the profile had limits;
        // this covers a settings-only profile.
        if (profile.name && report.limits === 'skipped') {
            const binding = await this.bindingsOf(summary.name, summary.deployType);
            const current = (await this.storeGet(binding, 'limits')) ?? defaultLimits();
            await this.storePut(binding, 'limits', { ...current, zagiroName: profile.name });
        }

        return report;
    }

    /** Reads a panel's current settings, to build a profile from it. */
    async readSettings(summary: PanelSummary): Promise<Record<string, any>> {
        const detail = await this.panelDetail(summary);
        if (!detail.host || !detail.securePath) {
            throw new Error('No address for this panel - run Repair first.');
        }

        const key = await this.wizardKey(summary);
        const res = await fetch(`https://${detail.host}/${detail.securePath}/api/settings`, {
            headers: { 'Authorization': `Bearer ${key}` }
        });
        const data = await res.json().catch(() => null) as any;
        if (!data?.success) throw new Error(data?.message ?? `HTTP ${res.status}`);

        return data.body?.settings ?? {};
    }

    /**
     * The key this panel accepts from the wizard, minting one if the panel
     * predates them. Panels installed by an older wizard have none.
     */
    private async wizardKey(summary: PanelSummary): Promise<string> {
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        const limits = (await this.storeGet(binding, 'limits')) ?? defaultLimits();
        if (limits.wizardKey) return limits.wizardKey;

        const { raw, entry } = await wizardKeyPair();
        const keys = Array.isArray(limits.panelApiKeys) ? limits.panelApiKeys : [];

        await this.storePut(binding, 'limits', {
            ...limits,
            wizardKey: raw,
            panelApiKeys: [...keys.filter((k: any) => k.name !== 'Wizard'), entry]
        });

        return raw;
    }

    /* ---------------------------------------------------------- deployment */

    /** Downloads the latest released panel script. */
    private async latestPanelScript(): Promise<string> {
        const res = await fetch('https://github.com/rexteamiran/ZAG-Panel/releases/latest/download/worker.js');
        if (!res.ok) throw new Error(`Could not download the latest panel: HTTP ${res.status}`);
        return await res.text();
    }

    /**
     * Redeploys a panel on the latest release, preserving its identity.
     *
     * The panel's EMBEDED_SETTINGS block carries its UUID, password and secure
     * path. It is re-attached to the new script unchanged, so existing
     * subscription links keep working.
     */
    async updatePanel(summary: PanelSummary): Promise<void> {
        if (summary.deployType === 'pages') {
            throw new Error('Updating Pages panels from here is not supported yet. Use the panel\'s own Update button.');
        }

        const settings = await this.embeddedSettings(summary.name, summary.deployType);
        if (!settings.securePath) {
            throw new Error('Could not read this panel\'s identity, so updating it would break its links.');
        }

        const script = await this.latestPanelScript();
        const binding = await this.bindingsOf(summary.name, summary.deployType);
        const worker = [
            `// ${settings.accEmail ?? ''}`,
            `// Updated: ${new Date().toISOString()}`,
            '// @ts-nocheck',
            `const EMBEDED_SETTINGS = ${JSON.stringify(settings)};${script}`
        ].join('\n');

        await this.uploadWorker(summary.name, worker, binding);
    }

    /** Adds a D1 database to a panel that was installed without one. */
    async addD1(summary: PanelSummary): Promise<string> {
        if (summary.deployType === 'pages') {
            throw new Error('Adding D1 to a Pages panel is not supported yet.');
        }

        const binding = await this.bindingsOf(summary.name, summary.deployType);
        if (binding.d1DatabaseId) return binding.d1DatabaseId;

        // Everything that can fail happens before anything is created, so a
        // failed attempt cannot leave an orphan database behind.
        const res = await fetch(
            `${API}/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(summary.name)}/content`,
            { headers: { 'Authorization': `Bearer ${this.token}` } }
        );

        if (!res.ok) {
            // Without this check a Cloudflare error page would be uploaded as
            // the worker, replacing a live panel with something that is not one.
            throw new Error(`Could not download the current panel script: HTTP ${res.status}`);
        }

        const current = await res.text();
        if (!parseEmbeddedSettings(current).securePath) {
            throw new Error('Could not read this panel\'s identity, so it cannot be safely redeployed.');
        }

        const database = await this.call<any>('/d1/database', {
            method: 'POST',
            body: JSON.stringify({ name: `${summary.name}-zagrooo` })
        });

        const databaseId = database?.uuid;
        if (!databaseId) throw new Error('Cloudflare did not return a database id.');

        // A binding only takes effect on redeploy.
        await this.uploadWorker(summary.name, current, { ...binding, d1DatabaseId: databaseId });
        return databaseId;
    }

    /**
     * Redeploys a worker, preserving everything about it except the code.
     *
     * `PUT /workers/scripts/{name}` replaces the whole script configuration,
     * so anything omitted is destroyed. Rebuilding the metadata from scratch
     * therefore wiped secrets, plain-text vars, any binding beyond the two the
     * wizard knows about, and silently bumped the compatibility date to today
     * — changing runtime semantics under a panel that was working.
     *
     * So the current settings are read first and used as the base.
     */
    private async uploadWorker(name: string, script: string, binding: PanelBinding): Promise<void> {
        const existing = await this.call<any>(
            `/workers/scripts/${encodeURIComponent(name)}/settings`
        ).catch(() => null);

        const keep: any[] = (existing?.bindings ?? []).filter(
            (b: any) => b?.name !== 'kv' && b?.name !== 'zag_db'
        );

        // Secrets read back with no value and must be carried by reference, or
        // the redeploy would blank them.
        const bindings: any[] = keep.map(b =>
            b.type === 'secret_text' ? { type: 'inherit', name: b.name } : b
        );

        bindings.push({ type: 'kv_namespace', name: 'kv', namespace_id: binding.kvNamespaceId });
        if (binding.d1DatabaseId) {
            bindings.push({ type: 'd1', name: 'zag_db', id: binding.d1DatabaseId });
        }

        const flags: string[] = existing?.compatibility_flags?.length
            ? existing.compatibility_flags
            : ['nodejs_compat'];

        if (!flags.includes('nodejs_compat')) flags.push('nodejs_compat');

        const metadata = {
            main_module: 'worker.js',
            // Keep the date the panel was deployed on; changing it changes how
            // the runtime behaves.
            compatibility_date: existing?.compatibility_date ?? new Date().toISOString().split('T')[0],
            compatibility_flags: flags,
            bindings,
            ...(existing?.usage_model ? { usage_model: existing.usage_model } : {}),
            ...(existing?.placement ? { placement: existing.placement } : {}),
            ...(existing?.limits ? { limits: existing.limits } : {}),
            ...(existing?.logpush !== undefined ? { logpush: existing.logpush } : {}),
            ...(existing?.observability ? { observability: existing.observability } : {})
        };

        const form = new FormData();
        form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        form.append('worker.js', new Blob([script], { type: 'application/javascript+module' }), 'worker.js');

        const res = await fetch(
            `${API}/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(name)}`,
            { method: 'PUT', headers: { 'Authorization': `Bearer ${this.token}` }, body: form }
        );

        const data = await res.json() as any;
        if (!res.ok || !data.success) {
            throw new Error(data?.errors?.[0]?.message ?? `Deploy failed: HTTP ${res.status}`);
        }
    }

    /** Fetches a panel's own status endpoint, to see whether it is alive. */
    async healthCheck(summary: PanelSummary): Promise<{ ok: boolean; detail: string }> {
        try {
            const detail = await this.panelDetail(summary);
            if (!detail.host || !detail.securePath) {
                return { ok: false, detail: 'address unknown' };
            }

            const res = await fetch(`https://${detail.host}/${detail.securePath}/sub/${detail.limits?.subToken ?? ''}`, {
                method: 'HEAD'
            });

            return res.ok
                ? { ok: true, detail: 'reachable' }
                : { ok: false, detail: `HTTP ${res.status}` };
        } catch (error) {
            return { ok: false, detail: String(error instanceof Error ? error.message : error) };
        }
    }

    async deletePanel(summary: PanelSummary): Promise<void> {
        const path = summary.deployType === 'pages'
            ? `/pages/projects/${encodeURIComponent(summary.name)}`
            : `/workers/scripts/${encodeURIComponent(summary.name)}`;

        await this.call(path, { method: 'DELETE' });
    }
}

/* ==========================================================================
   Helpers
   ========================================================================== */

export function describeStatus(limits: any, usage: any): string {
    if (!limits) return 'unknown';
    if (limits.isPaused) return 'paused';
    if (limits.expireAt && Date.now() > limits.expireAt) return 'expired';

    const total = usage?.totalBytes ?? 0;
    const daily = usage?.dailyBytes ?? 0;

    if (limits.limitTotalBytes && total >= limits.limitTotalBytes) return 'limited';
    if (limits.limitDailyBytes && daily >= limits.limitDailyBytes) return 'daily-limited';
    return 'active';
}

/** Whitelist and coerce, so a malformed request cannot corrupt the record. */
function sanitiseLimits(patch: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const numeric = [
        'limitTotalBytes',
        'limitDailyBytes',
        'downSpeedKbps',
        'upSpeedKbps',
        'expireAt',
        'maxDevices',
        'monthlyResetDay'
    ];

    for (const field of numeric) {
        if (patch[field] === undefined) continue;
        const value = Math.floor(Number(patch[field]));
        if (Number.isFinite(value) && value >= 0) out[field] = value;
    }

    if (patch.displayName !== undefined) out.displayName = String(patch.displayName).slice(0, 64);

    // zagiroName labels the panel with the profile applied; showStatusNodes
    // drives the in-client notes. Both were dropped here, which made the
    // dashboard's checkbox inert and left every panel unlabelled.
    if (patch.zagiroName !== undefined) out.zagiroName = String(patch.zagiroName).slice(0, 60);

    for (const flag of ['monthlyReset', 'alertQuota', 'alertExpiry', 'isPaused', 'showStatusNodes'] as const) {
        if (patch[flag] !== undefined) out[flag] = Boolean(patch[flag]);
    }

    return out;
}

/* ==========================================================================
   Account-wide request quota

   Cloudflare's free plan allows 100,000 Worker requests per day across the
   whole ACCOUNT, not per worker. Twenty panels share one budget, and when it
   runs out every customer stops at once. Worth watching.
   ========================================================================== */

export const FREE_PLAN_DAILY_REQUESTS = 100_000;

export interface AccountUsage {
    requests: number;
    limit: number;
    percent: number;
    since: string;
}

export async function accountUsage(token: string, accountId: string): Promise<AccountUsage> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const query = {
        query: `query Usage($accountTag: String!, $start: String!) {
            viewer {
                accounts(filter: { accountTag: $accountTag }) {
                    workersInvocationsAdaptive(limit: 100, filter: { datetime_geq: $start }) {
                        sum { requests }
                    }
                }
            }
        }`,
        variables: { accountTag: accountId, start: since }
    };

    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
    });

    if (!res.ok) throw new Error(`Analytics request failed: HTTP ${res.status}`);

    const data = await res.json() as any;

    // GraphQL reports a permission denial as 200 with errors[] and data: null.
    // Reading only `data` turns that into "0 requests", which is exactly the
    // reassurance the operator must not be given.
    if (Array.isArray(data?.errors) && data.errors.length) {
        const message = data.errors[0]?.message ?? 'unknown error';
        throw new Error(
            /permission|denied|unauthor/i.test(message)
                ? 'Your API token is missing the Account Analytics: Read permission.'
                : `Analytics query failed: ${message}`
        );
    }

    const accounts = data?.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || !accounts.length) {
        throw new Error('Analytics returned no data for this account.');
    }

    const rows = accounts[0]?.workersInvocationsAdaptive ?? [];
    const requests = rows.reduce((sum: number, row: any) => sum + (row?.sum?.requests ?? 0), 0);

    return {
        requests,
        limit: FREE_PLAN_DAILY_REQUESTS,
        percent: Math.min(100, (requests / FREE_PLAN_DAILY_REQUESTS) * 100),
        since
    };
}

/* ==========================================================================
   ZagiRo profiles

   Saved bundles of settings and limits that can be applied to any set of
   panels later.

   They live in a KV namespace the wizard finds by title and creates on first
   use. That keeps them tied to the Cloudflare account rather than a browser,
   and needs no binding in wrangler.toml - which matters because the local
   edition has no worker to bind anything to.
   ========================================================================== */

const PROFILE_NAMESPACE_TITLE = 'zagrooo-wizard-profiles';
const PROFILE_KEY = 'zagiro';

export interface ZagiroProfile {
    id: string;
    name: string;
    note: string;
    updatedAt: number;
    /** Subset of the panel's KvSettings. Empty when the profile carries none. */
    settings: Record<string, any> | null;
    /** Subset of PanelLimits. Empty when the profile carries none. */
    limits: Record<string, any> | null;
    /**
     * How long the subscription should run from the moment the profile is
     * applied. Stored as a duration rather than a date so one profile can be
     * reused for every new customer.
     */
    validDays?: number;
}

export class ProfileStore {
    private readonly token: string;
    private readonly accountId: string;
    private namespaceId = '';

    constructor(token: string, accountId: string) {
        this.token = token;
        this.accountId = accountId;
    }

    private headers(json = false): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.token}`,
            ...(json ? { 'Content-Type': 'application/json' } : {})
        };
    }

    /** Finds the profile namespace, creating it the first time. */
    private async namespace(): Promise<string> {
        if (this.namespaceId) return this.namespaceId;

        const listRes = await fetch(
            `${API}/accounts/${this.accountId}/storage/kv/namespaces?per_page=100`,
            { headers: this.headers() }
        );
        const list = await listRes.json() as any;

        const found = (list?.result ?? []).find((ns: any) => ns.title === PROFILE_NAMESPACE_TITLE);
        if (found) {
            this.namespaceId = found.id;
            return this.namespaceId;
        }

        const createRes = await fetch(`${API}/accounts/${this.accountId}/storage/kv/namespaces`, {
            method: 'POST',
            headers: this.headers(true),
            body: JSON.stringify({ title: PROFILE_NAMESPACE_TITLE })
        });
        const created = await createRes.json() as any;

        if (!created?.success) {
            const message = created?.errors?.[0]?.message ?? `HTTP ${createRes.status}`;
            throw new Error(`Could not create the profile store: ${message}`);
        }

        this.namespaceId = created.result.id;
        return this.namespaceId;
    }

    async list(): Promise<ZagiroProfile[]> {
        const ns = await this.namespace();
        const res = await fetch(
            `${API}/accounts/${this.accountId}/storage/kv/namespaces/${ns}/values/${PROFILE_KEY}`,
            { headers: this.headers() }
        );

        if (!res.ok) return [];
        const profiles = await res.json().catch(() => null) as ZagiroProfile[] | null;
        return Array.isArray(profiles) ? profiles : [];
    }

    private async writeAll(profiles: ZagiroProfile[]): Promise<void> {
        const ns = await this.namespace();
        const form = new FormData();
        form.append('value', JSON.stringify(profiles));
        form.append('metadata', '{}');

        const res = await fetch(
            `${API}/accounts/${this.accountId}/storage/kv/namespaces/${ns}/values/${PROFILE_KEY}`,
            { method: 'PUT', headers: this.headers(), body: form }
        );

        if (!res.ok) throw new Error(`Could not save profiles: HTTP ${res.status}`);
    }

    async save(profile: Partial<ZagiroProfile>): Promise<ZagiroProfile> {
        const profiles = await this.list();
        const now = Date.now();

        const existing = profile.id ? profiles.find(p => p.id === profile.id) : undefined;
        const next: ZagiroProfile = {
            id: existing?.id ?? crypto.randomUUID(),
            name: String(profile.name ?? existing?.name ?? 'Untitled').slice(0, 60),
            note: String(profile.note ?? existing?.note ?? '').slice(0, 200),
            updatedAt: now,
            settings: profile.settings !== undefined ? profile.settings : (existing?.settings ?? null),
            limits: profile.limits !== undefined ? profile.limits : (existing?.limits ?? null),
            validDays: profile.validDays !== undefined ? profile.validDays : existing?.validDays
        };

        const merged = existing
            ? profiles.map(p => (p.id === next.id ? next : p))
            : [...profiles, next];

        await this.writeAll(merged);
        return next;
    }

    async remove(id: string): Promise<void> {
        const profiles = await this.list();
        await this.writeAll(profiles.filter(p => p.id !== id));
    }
}
