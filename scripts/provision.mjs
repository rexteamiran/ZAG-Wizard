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
 * Searches every page of the account's databases for one by name.
 *
 * This endpoint returns no result_info, so the loop cannot ask when to stop —
 * it runs until a page comes back empty. Stopping after page one is exactly
 * the bug that made an existing database invisible once the account held more
 * than a page of them, and made every later deploy try to create it again.
 */
async function findDatabase(id, name) {
    for (let marker = 1; marker <= 25; marker++) {
        const page = await cf(`/accounts/${id}/d1/database?page=${marker}&per_page=25`);
        const result = page.result ?? [];

        const found = result.find(db => db.name === name);
        if (found) return found;

        if (result.length === 0) return null;
    }

    return null;
}

/** First existing database, preferring one the panel line already owns. */
async function reuseCandidate(id) {
    const page = await cf(`/accounts/${id}/d1/database?page=1&per_page=25`);
    const result = page.result ?? [];

    const owned = result.find(db => db.uuid && db.name?.endsWith('-zagrooo'));
    return owned ?? result.find(db => db.uuid && db.name) ?? null;
}

async function main() {
    const id = await accountId();
    console.log(`Account: ${id}`);

    let database = await findDatabase(id, DB_NAME);

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
                // Created between the search and this attempt — most likely by
                // a run whose search missed it. Look again; reuse only if the
                // list still will not show it.
                database = await findDatabase(id, DB_NAME);
                if (database) {
                    console.log(`Found existing database ${DB_NAME} (${database.uuid}).`);
                }
            }

            if (!database && /limit reached|databases per account|quota/i.test(message)) {
                // The free plan caps accounts at ten D1 databases. Accounts
                // that ran the 1.2.x wizard have ten per-panel databases —
                // the wizard only needs its own small store, so any existing
                // database works: its tables are created on first use and do
                // not collide with a panel's `zag_store`.
                console.warn('The account is at the D1 database limit. Reusing an existing database for the wizard.');
                database = await reuseCandidate(id);
                if (database) {
                    console.log(`Reusing ${database.name} (${database.uuid}) for the wizard.`);
                }
            }

            if (!database) {
                if (/already exists/i.test(message)) {
                    console.warn(`The API says ${DB_NAME} exists but the list does not show it. Reusing an existing database instead.`);
                    database = await reuseCandidate(id);
                    if (database) console.log(`Reusing ${database.name} (${database.uuid}) for the wizard.`);
                }

                if (!database) throw error;
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
