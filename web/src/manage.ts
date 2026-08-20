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

        const workers = await Promise.all(
            (scripts ?? []).map(async script => {
                const bindings = await this.workerBindings(script.id).catch(() => []);
                return {
                    name: script.id,
                    deployType: 'workers' as const,
                    modifiedOn: script.modified_on ?? '',
                    hasKv: bindings.some(b => b.name === 'kv'),
                    hasD1: bindings.some(b => b.name === 'zag_db')
                };
            })
        );

        const pages = (projects ?? []).map(project => {
            const config = project.deployment_configs?.production ?? {};
            return {
                name: project.name,
                deployType: 'pages' as const,
                modifiedOn: project.latest_deployment?.modified_on ?? project.created_on ?? '',
                hasKv: Boolean(config.kv_namespaces?.kv),
                hasD1: Boolean(config.d1_databases?.zag_db)
            };
        });

        // A `kv` binding is what makes something a ZAGROOO panel rather than
        // some other worker on the same account.
        return [...workers, ...pages].filter(panel => panel.hasKv);
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

    private async storeGet(binding: PanelBinding, key: string): Promise<any | null> {
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

    private async storePut(binding: PanelBinding, key: string, value: unknown): Promise<void> {
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
    private async embeddedSettings(name: string, deployType: string): Promise<Record<string, any>> {
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
        const source = await res.text();
        const match = source.match(/EMBEDED_SETTINGS\s*=\s*(\{.*?\});/s);
        if (!match) return {};

        try {
            return JSON.parse(match[1]);
        } catch (error) {
            return {};
        }
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

            const host = settings.mainDomain ?? '';
            const securePath = settings.securePath ?? '';

            return {
                ...base,
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

        // Raising a limit should revive a panel that was paused by hitting it.
        if (next.isPaused && patch.isPaused === undefined && describeStatus(next, await this.storeGet(binding, 'usage')) === 'active') {
            next.isPaused = false;
            next.pauseReason = '';
            next.pausedAt = 0;
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

/**
 * The panel writes its own limits record the first time it runs. A panel that
 * has just been installed and never opened has none, and the whole point of
 * this wizard is that a panel never has to be opened by hand -- so the wizard
 * seeds the record itself, matching src/settings/usage.ts defaultLimits().
 */
function randomToken(bytes = 16): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function defaultLimits(): Record<string, any> {
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
    for (const flag of ['monthlyReset', 'alertQuota', 'alertExpiry', 'isPaused'] as const) {
        if (patch[flag] !== undefined) out[flag] = Boolean(patch[flag]);
    }

    return out;
}
