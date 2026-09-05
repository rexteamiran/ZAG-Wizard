/**
 * Finds or creates the wizard's own D1 database and writes its id into
 * wrangler.toml, so `wrangler deploy` runs hands-free from CI.
 *
 *   node scripts/provision.mjs
 *
 * Requires CLOUDFLARE_API_TOKEN (and optionally CLOUDFLARE_ACCOUNT_ID) in the
 * environment. The token needs D1:Edit on the target account.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const API = 'https://api.cloudflare.com/client/v4';
const DB_NAME = 'zagrooo-wizard';
const PLACEHOLDER = '__D1_DATABASE_ID__';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const configPath = join(root, 'wrangler.toml');

const token = process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
    console.error('CLOUDFLARE_API_TOKEN is not set.');
    process.exit(1);
}

const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };

async function cf(path, init = {}) {
    const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const data = await res.json();
    if (!res.ok || data.success === false) {
        throw new Error(data?.errors?.[0]?.message ?? `HTTP ${res.status} on ${path}`);
    }
    return data.result;
}

async function accountId() {
    if (process.env.CLOUDFLARE_ACCOUNT_ID) return process.env.CLOUDFLARE_ACCOUNT_ID;
    const accounts = await cf('/accounts');
    return accounts[0]?.id;
}

/**
 * Every database the list endpoint will admit to, across all pages. The names
 * are printed so a future failure shows exactly what the API returned.
 */
async function listDatabases(id) {
    const all = [];

    for (let marker = 1; marker <= 25; marker++) {
        const page = await cf(`/accounts/${id}/d1/database?page=${marker}&per_page=25`);
        const result = Array.isArray(page) ? page : (page.result ?? []);

        if (!result.length) break;
        all.push(...result);
        if (result.length < 25) break;
    }

    console.log(`D1 list returned ${all.length} database(s):`);
    for (const db of all) {
        console.log(`  - ${db.name} (${db.uuid ?? 'no id'})`);
    }

    return all;
}

function byName(databases, name) {
    const wanted = name.toLowerCase();
    return databases.find(db => (db.name ?? '').toLowerCase() === wanted && db.uuid) ?? null;
}

/** Any usable database, preferring ones the panel line already owns. */
function reuseCandidate(databases) {
    return databases.find(db => db.uuid && db.name?.endsWith('-zagrooo'))
        ?? databases.find(db => db.uuid && db.name?.startsWith('zagrooo'))
        ?? databases.find(db => db.uuid && db.name)
        ?? null;
}

/**
 * The get-by-name endpoint, which can see a database the paginated list
 * hides — it has been observed disagreeing with the list, and the deploy
 * must not die over a disagreement.
 */
async function getByName(id, name) {
    try {
        const db = await cf(`/accounts/${id}/d1/database/${encodeURIComponent(name)}`);
        if (db?.uuid) return db;
        return null;
    } catch (error) {
        return null;
    }
}

async function main() {
    const id = await accountId();
    console.log(`Account: ${id}`);

    const databases = await listDatabases(id);
    let database = byName(databases, DB_NAME);

    if (database) {
        console.log(`Found existing database ${DB_NAME} (${database.uuid}).`);
    } else {
        try {
            database = await cf(`/accounts/${id}/d1/database`, {
                method: 'POST',
                body: JSON.stringify({ name: DB_NAME })
            });
            console.log(`Created database ${DB_NAME} (${database.uuid}).`);
        } catch (error) {
            const message = String(error.message ?? error);

            if (/already exists/i.test(message)) {
                // The list disagrees with create. Ask the get-by-name
                // endpoint directly; that one has been right before.
                database = await getByName(id, DB_NAME);
                if (database) {
                    console.log(`Found ${DB_NAME} via direct lookup (${database.uuid}).`);
                }
            }

            if (!database && /limit reached|databases per account|quota/i.test(message)) {
                // The free plan caps accounts at ten D1 databases. Accounts
                // that ran the 1.2.x wizard have ten per-panel databases —
                // the wizard only needs its own small store, so any existing
                // database works: its tables are created on first use and do
                // not collide with a panel's `zag_store`.
                console.warn('The account is at the D1 database limit. Reusing an existing database for the wizard.');
                database = reuseCandidate(databases);
                if (database) console.log(`Reusing ${database.name} (${database.uuid}) for the wizard.`);
            }

            if (!database) {
                // Last resort for every other failure, including a stubborn
                // 'already exists': reuse whatever exists rather than die.
                console.warn(`Could not create ${DB_NAME} (${message}). Reusing an existing database instead.`);
                database = reuseCandidate(databases);
                if (database) console.log(`Reusing ${database.name} (${database.uuid}) for the wizard.`);
            }

            if (!database) {
                throw new Error(
                    `No D1 database is available: the account has none the API will show, ` +
                    `and creating ${DB_NAME} failed (${message}). ` +
                    `Delete an unused database in the Cloudflare dashboard and run the deploy again.`
                );
            }
        }
    }

    let toml = readFileSync(configPath, 'utf8');
    if (toml.includes(PLACEHOLDER)) {
        toml = toml.replace(PLACEHOLDER, database.uuid);
        writeFileSync(configPath, toml);
        console.log('wrangler.toml updated with the database id.');
    } else if (!toml.includes(database.uuid)) {
        console.warn('wrangler.toml has no placeholder — leaving it untouched.');
    }
}

main().catch(error => {
    console.error(`Provision failed: ${error.message}`);
    process.exit(1);
});
