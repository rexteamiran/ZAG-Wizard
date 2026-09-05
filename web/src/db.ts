/* ==========================================================================
   Wizard database

   The wizard's own D1 database (bound as `db`) holds everything the
   dashboard needs: user accounts, sessions, the panel API connections each
   user saved, their ZagiRo profiles, and the install-name counters.

   Tables are created lazily on the first request of an isolate, so the
   deploy pipeline never needs a migration step.
   ========================================================================== */

const SCHEMA: string[] = [
    `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        pass TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        api_url TEXT NOT NULL,
        api_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        settings TEXT,
        limits TEXT,
        valid_days INTEGER,
        updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS counters (
        prefix TEXT PRIMARY KEY,
        value INTEGER NOT NULL
    )`
];

let ready = false;

export async function ensureSchema(db: D1Database): Promise<void> {
    if (ready) return;
    // exec() splits on semicolons that live inside statements too, so each
    // CREATE goes over as its own prepared statement instead.
    for (const statement of SCHEMA) {
        await db.prepare(statement).run();
    }
    ready = true;
}

export async function query<T>(db: D1Database, sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await db.prepare(sql).bind(...params).all<T>();
    return (result.results ?? []) as T[];
}

export async function run(db: D1Database, sql: string, params: unknown[] = []): Promise<void> {
    await db.prepare(sql).bind(...params).run();
}

/**
 * Atomically claims the next block of the name counter for a prefix.
 * Returns the first number this caller may use.
 */
export async function takeCounter(db: D1Database, prefix: string, amount: number): Promise<number> {
    const rows = await query<{ value: number }>(
        db,
        `INSERT INTO counters (prefix, value) VALUES (?, ?)
         ON CONFLICT(prefix) DO UPDATE SET value = value + excluded.value
         RETURNING value`,
        [prefix, amount]
    );

    const total = rows[0]?.value ?? amount;
    return total - amount + 1;
}
