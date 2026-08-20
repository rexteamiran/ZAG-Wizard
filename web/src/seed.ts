/* ==========================================================================
   Panel record seeding

   A panel writes its own limits record the first time it runs, which means a
   freshly installed panel that nobody has opened has none — and the dashboard
   then has nothing to show or edit.

   So the wizard writes it at install time. It also records where the panel
   lives, because the wizard knows the host and secure path here, while the
   dashboard would otherwise have to recover them by parsing the deployed
   script — which fails silently and leaves the links blank.
   ========================================================================== */

const API = 'https://api.cloudflare.com/client/v4';

export interface PanelSeed {
    displayName: string;
    panelHost: string;
    panelPath: string;
}

function randomToken(bytes = 16): string {
    const buffer = new Uint8Array(bytes);
    crypto.getRandomValues(buffer);
    return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Mints the key the wizard uses to reach the panel's own endpoints. The panel
 * stores only the hash for verification; the raw key sits beside it so the
 * wizard can read it back later.
 */
export async function wizardKeyPair(): Promise<{ raw: string; entry: Record<string, any> }> {
    const raw = randomToken(32);
    return {
        raw,
        entry: {
            id: crypto.randomUUID(),
            name: 'Wizard',
            hash: await sha256(raw),
            createdAt: Date.now(),
            lastUsed: 0
        }
    };
}

/** Matches src/settings/usage.ts defaultLimits() in the panel. */
export function defaultLimits(seed: Partial<PanelSeed> = {}): Record<string, any> {
    return {
        displayName: seed.displayName ?? '',
        subToken: randomToken(),
        panelHost: seed.panelHost ?? '',
        panelPath: seed.panelPath ?? '',
        showStatusNodes: true,
        zagiroName: '',
        wizardKey: '',
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

async function d1Write(
    token: string,
    accountId: string,
    databaseId: string,
    key: string,
    value: unknown
): Promise<void> {
    const run = async (sql: string, params: unknown[]) => {
        const res = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sql, params })
        });

        if (!res.ok) throw new Error(`D1 write failed: HTTP ${res.status}`);
    };

    await run('CREATE TABLE IF NOT EXISTS zag_store (key TEXT PRIMARY KEY, value TEXT)', []);
    await run(
        'INSERT INTO zag_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)]
    );
}

async function kvWrite(
    token: string,
    accountId: string,
    namespaceId: string,
    key: string,
    value: unknown
): Promise<void> {
    const form = new FormData();
    form.append('value', JSON.stringify(value));
    form.append('metadata', '{}');

    const res = await fetch(
        `${API}/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`,
        { method: 'PUT', headers: { 'Authorization': `Bearer ${token}` }, body: form }
    );

    if (!res.ok) throw new Error(`KV write failed: HTTP ${res.status}`);
}

/**
 * Writes the panel's initial limits record. Prefers D1, falls back to KV, and
 * returns the record so the caller can report the portal link.
 */
export async function seedPanelRecord(
    token: string,
    accountId: string,
    namespaceId: string,
    databaseId: string,
    seed: PanelSeed
): Promise<Record<string, any>> {
    const record = defaultLimits(seed);

    const { raw, entry } = await wizardKeyPair();
    record.wizardKey = raw;
    record.panelApiKeys = [entry];

    if (databaseId) {
        try {
            await d1Write(token, accountId, databaseId, 'limits', record);
            return record;
        } catch (error) {
            console.log('D1 seed failed, falling back to KV:', error);
        }
    }

    await kvWrite(token, accountId, namespaceId, 'limits', record);
    return record;
}
