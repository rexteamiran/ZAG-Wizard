/* ==========================================================================
   Panel record seeding

   The panel reads and writes its limits record in the account's shared D1
   database, namespaced by panel id. The wizard seeds it at install so a
   freshly installed panel is manageable the moment it exists — and seeds the
   first API key, which is what the dashboard uses to reach the panel later.
   ========================================================================== */

const API = 'https://api.cloudflare.com/client/v4';
const TABLE = 'zag_store';

export interface PanelSeed {
    displayName: string;
    panelHost: string;
    panelPath: string;
    panelId: string;
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

export function defaultLimits(seed: Partial<PanelSeed> = {}): Record<string, any> {
    return {
        displayName: seed.displayName ?? '',
        subToken: randomToken(),
        panelHost: seed.panelHost ?? '',
        panelPath: seed.panelPath ?? '',
        showStatusNodes: true,
        zagiroName: '',
        limitTotalBytes: 0,
        limitDailyBytes: 0,
        downSpeedKbps: 0,
        upSpeedKbps: 0,
        expireAt: 0,
        maxDevices: 0,
        isPaused: false,
        pauseReason: '',
        pausedAt: 0,
        pausedBy: '',
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
    const res = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sql: `INSERT INTO ${TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
            params: [key, JSON.stringify(value)]
        })
    });

    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`D1 write failed: HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
}

/**
 * Seeds the panel's limits record and its first API key. Returns the raw key
 * (shown once, for the dashboard) plus the seeded record, for the portal link.
 *
 * The table may not exist on a brand-new shared database, so it is created
 * here — the panel does the same lazily, and whichever comes up first wins.
 */
export async function seedPanelRecord(
    token: string,
    accountId: string,
    databaseId: string,
    seed: PanelSeed
): Promise<{ record: Record<string, any>; apiKey: string }> {
    const create = await fetch(`${API}/accounts/${accountId}/d1/database/${databaseId}/query`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT)` })
    });
    if (!create.ok) throw new Error(`Could not prepare the panel database: HTTP ${create.status}`);

    const record = defaultLimits(seed);

    const rawKey = randomToken(32);
    record.panelApiKeys = [{
        id: crypto.randomUUID(),
        name: 'Dashboard',
        hash: await sha256(rawKey),
        createdAt: Date.now(),
        lastUsed: 0
    }];

    await d1Write(token, accountId, databaseId, `${seed.panelId}:limits`, record);

    return { record, apiKey: rawKey };
}
