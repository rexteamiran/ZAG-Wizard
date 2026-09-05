/* ==========================================================================
   Dashboard API — connections and profiles

   The dashboard talks to panels directly from the browser (panels send CORS
   headers). This module only stores what the browser cannot: the connection
   list per user, with API keys encrypted at rest, and their ZagiRo profiles.

   Everything is scoped by user id — no one ever reads another user's
   connections.
   ========================================================================== */

import { ensureSchema, query, run } from './db';
import { decrypt, encrypt } from './encryption';

export interface ConnectionRow {
    id: string;
    label: string;
    api_url: string;
    api_key: string;
    created_at: number;
}

export interface ProfileRow {
    id: string;
    name: string;
    note: string;
    settings: string | null;
    limits: string | null;
    valid_days: number | null;
    updated_at: number;
}

async function withDb<T>(env: Env, fn: () => Promise<T>): Promise<T> {
    await ensureSchema(env.db);
    return await fn();
}

/* ------------------------------------------------------------- connections */

/**
 * Lists the user's connections with decrypted API keys. The browser needs the
 * raw keys — it calls the panels' APIs directly, server-side only as far as
 * storage is concerned. Only the owning user's session can ever see them.
 */
export async function listConnections(env: Env, userId: string): Promise<Array<ConnectionRow>> {
    return withDb(env, async () => {
        const rows = await query<ConnectionRow>(
            env.db,
            'SELECT * FROM connections WHERE user_id = ? ORDER BY created_at',
            [userId]
        );

        return Promise.all(rows.map(async ({ api_key, ...rest }) => ({
            ...rest,
            api_key: await decrypt(api_key, env.SECRET)
        })));
    });
}

export async function addConnection(env: Env, userId: string, body: Record<string, any>): Promise<ConnectionRow> {
    return withDb(env, async () => {
        const label = String(body.label ?? '').trim().slice(0, 60);
        const apiUrl = normaliseApiUrl(String(body.apiUrl ?? ''));
        const apiKey = String(body.apiKey ?? '').trim();

        if (!label) throw new Error('Give this connection a name.');
        if (!apiUrl) throw new Error('Missing panel API address.');
        if (!apiKey) throw new Error('Missing API key.');

        const row: ConnectionRow = {
            id: crypto.randomUUID(),
            label,
            api_url: apiUrl,
            api_key: await encrypt(apiKey, env.SECRET),
            created_at: Date.now()
        };

        await run(
            env.db,
            'INSERT INTO connections (id, user_id, label, api_url, api_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [row.id, userId, row.label, row.api_url, row.api_key, row.created_at]
        );

        // The caller just typed the key; hand it back in the clear so the
        // response reads the same as the stored-encrypted list endpoint.
        return { ...row, api_key: apiKey };
    });
}

export async function updateConnection(env: Env, userId: string, id: string, body: Record<string, any>): Promise<void> {
    return withDb(env, async () => {
        const rows = await query<ConnectionRow>(
            env.db, 'SELECT * FROM connections WHERE id = ? AND user_id = ?', [id, userId]
        );
        const row = rows[0];
        if (!row) throw new Error('No such connection.');

        const label = body.label !== undefined ? String(body.label).trim().slice(0, 60) || row.label : row.label;
        const apiUrl = body.apiUrl !== undefined ? normaliseApiUrl(String(body.apiUrl)) || row.api_url : row.api_url;
        const apiKey = body.apiKey ? await encrypt(String(body.apiKey).trim(), env.SECRET) : row.api_key;

        await run(
            env.db,
            'UPDATE connections SET label = ?, api_url = ?, api_key = ? WHERE id = ? AND user_id = ?',
            [label, apiUrl, apiKey, id, userId]
        );
    });
}

export async function deleteConnection(env: Env, userId: string, id: string): Promise<void> {
    return withDb(env, async () => {
        await run(env.db, 'DELETE FROM connections WHERE id = ? AND user_id = ?', [id, userId]);
    });
}

/**
 * Returns the decrypted key for a connection the user owns.
 */
export async function resolveConnection(env: Env, userId: string, id: string): Promise<{ apiUrl: string; apiKey: string }> {
    return withDb(env, async () => {
        const rows = await query<ConnectionRow>(
            env.db, 'SELECT * FROM connections WHERE id = ? AND user_id = ?', [id, userId]
        );
        const row = rows[0];
        if (!row) throw new Error('No such connection.');

        return { apiUrl: row.api_url, apiKey: await decrypt(row.api_key, env.SECRET) };
    });
}

/** Accepts the panel base URL or its /panel page; stores the API root. */
export function normaliseApiUrl(raw: string): string {
    let url = raw.trim().replace(/\/+$/, '');
    if (!url) return '';

    if (!/^https:\/\//i.test(url)) url = `https://${url}`;
    // "https://host/path/panel" -> "https://host/path/api"
    url = url.replace(/\/panel$/, '/api');
    if (!/\/api$/.test(url)) url = `${url}/api`;

    try {
        const parsed = new URL(url);
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch (error) {
        throw new Error('That panel address does not look like a URL.');
    }
}

/* ---------------------------------------------------------------- profiles */

export interface ZagiroProfile {
    id: string;
    name: string;
    note: string;
    updatedAt: number;
    settings: Record<string, any> | null;
    limits: Record<string, any> | null;
    validDays?: number;
}

export async function listProfiles(env: Env, userId: string): Promise<ZagiroProfile[]> {
    return withDb(env, async () => {
        const rows = await query<ProfileRow>(
            env.db, 'SELECT * FROM profiles WHERE user_id = ? ORDER BY name', [userId]
        );

        return rows.map(row => ({
            id: row.id,
            name: row.name,
            note: row.note,
            updatedAt: row.updated_at,
            settings: row.settings ? JSON.parse(row.settings) : null,
            limits: row.limits ? JSON.parse(row.limits) : null,
            validDays: row.valid_days ?? undefined
        }));
    });
}

export async function saveProfile(env: Env, userId: string, profile: Partial<ZagiroProfile>): Promise<ZagiroProfile> {
    return withDb(env, async () => {
        const existing = profile.id
            ? (await query<ProfileRow>(env.db, 'SELECT * FROM profiles WHERE id = ? AND user_id = ?', [profile.id, userId]))[0]
            : undefined;

        const next: ZagiroProfile = {
            id: existing?.id ?? crypto.randomUUID(),
            name: String(profile.name ?? existing?.name ?? 'Untitled').slice(0, 60),
            note: String(profile.note ?? existing?.note ?? '').slice(0, 200),
            updatedAt: Date.now(),
            settings: profile.settings !== undefined ? profile.settings : existing ? jsonOrNull(existing.settings) : null,
            limits: profile.limits !== undefined ? profile.limits : existing ? jsonOrNull(existing.limits) : null,
            validDays: profile.validDays !== undefined ? profile.validDays : existing?.valid_days ?? undefined
        };

        await run(
            env.db,
            `INSERT INTO profiles (id, user_id, name, note, settings, limits, valid_days, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, note = excluded.note,
                 settings = excluded.settings, limits = excluded.limits,
                 valid_days = excluded.valid_days, updated_at = excluded.updated_at`,
            [
                next.id, userId, next.name, next.note,
                next.settings ? JSON.stringify(next.settings) : null,
                next.limits ? JSON.stringify(next.limits) : null,
                next.validDays ?? null,
                next.updatedAt
            ]
        );

        return next;
    });
}

export async function deleteProfile(env: Env, userId: string, id: string): Promise<void> {
    return withDb(env, async () => {
        await run(env.db, 'DELETE FROM profiles WHERE id = ? AND user_id = ?', [id, userId]);
    });
}

function jsonOrNull(raw: string | null): Record<string, any> | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}
