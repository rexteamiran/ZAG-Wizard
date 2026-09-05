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

async function main() {
    const id = await accountId();
    console.log(`Account: ${id}`);

    let database = null;
    let marker = 1;
    for (;;) {
        const page = await cf(`/accounts/${id}/d1/database?page=${marker}&per_page=50`);
        database = page.result?.find(db => db.name === DB_NAME);
        if (database || !page.result_info || marker * 50 >= (page.result_info.total_count ?? 0)) break;
        marker++;
    }

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
            // The free plan caps accounts at ten D1 databases. Accounts that
            // ran the 1.2.x wizard have ten per-panel databases already —
            // that is exactly the situation, and the wizard only needs its
            // own small store. Any existing database works: the wizard's
            // tables are created on first use, and its table names do not
            // collide with a panel's `zag_store`.
            const message = String(error.message ?? error);
            if (/limit reached|databases per account|quota/i.test(message)) {
                console.warn('The account is at the D1 database limit. Reusing the first existing database for the wizard.');
                const page = await cf(`/accounts/${id}/d1/database?page=1&per_page=1`);
                database = page.result?.[0];
                if (!database?.uuid) throw new Error('No existing database to reuse.');
                console.log(`Reusing ${database.name} (${database.uuid}) for the wizard.`);
            } else {
                throw error;
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
