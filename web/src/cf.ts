/* ==========================================================================
   Cloudflare account access — install-time only

   The dashboard never holds a Cloudflare token; only the install page does,
   and only for the length of one install. Everything here exists to create
   panels: verify the token, find or create the account's shared panel
   database, deploy a worker or Pages project bound to it.
   ========================================================================== */

import Cloudflare, { Uploadable } from 'cloudflare';
import { randSubdomain } from './random';

/** Every ZAGROOO panel of one account binds this single D1 database. */
export const SHARED_DB_NAME = 'zagrooo-panels';

export class CFAccount {
    readonly token: string;
    readonly id: string;
    readonly email: string;
    readonly client: Cloudflare;

    private constructor(token: string, client: Cloudflare, id: string, email: string) {
        this.token = token;
        this.client = client;
        this.id = id;
        this.email = email;
    }

    static async create(token: string): Promise<CFAccount> {
        const client = new Cloudflare({ apiToken: token });

        const response = await client.user.tokens.verify();
        if (response.status !== 'active') {
            throw new Error(`API token is ${response.status}.`);
        }

        const [accounts, user] = await Promise.all([
            client.accounts.list(),
            client.user.get(),
        ]);

        return new CFAccount(token, client, accounts.result[0].id, user.email.toLowerCase());
    }

    async nameTaken(deployType: string, name: string): Promise<boolean> {
        try {
            if (deployType === 'pages') {
                // A taken Pages name must be reported as taken; falling
                // through to the workers check below made a 404 on the worker
                // side hide the collision until mid-install.
                await this.client.pages.projects.get(name, { account_id: this.id });
                return true;
            }

            await this.client.workers.scripts.get(name, { account_id: this.id });
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * Finds the account's shared panel database, creating it on first use.
     * One database for every panel keeps installs under the free plan's
     * ten-database cap, however many panels an account runs — each panel
     * namespaces its own rows inside it.
     *
     * When the account is already at that cap — the normal state for an
     * account that ran the 1.2.x wizard, whose ten per-panel databases fill
     * the quota — the first existing database is reused instead. Panels
     * namespace every row with their panel id, so sharing is safe; the only
     * name a panel touches is its own `zag_store` table, which the 1.2.x
     * panels also used.
     */
    async findOrCreateSharedDatabase(): Promise<{ id: string; name: string; created: boolean }> {
        const existing = await this.client.d1.database.list({ account_id: this.id });
        const found = existing.result.find(db => db.name === SHARED_DB_NAME);
        if (found?.uuid && found.name) return { id: found.uuid, name: found.name, created: false };

        try {
            const created = await this.client.d1.database.create({
                account_id: this.id,
                name: SHARED_DB_NAME
            });

            const id = created.uuid ?? '';
            if (!id) throw new Error('Cloudflare returned no database id.');

            return { id, name: SHARED_DB_NAME, created: true };
        } catch (error) {
            const message = String((error as any)?.message ?? error);

            // Two installs racing each other: the loser's create fails with
            // "already exists" because the winner just made it. Look it up
            // instead of dying.
            if (/already exists/i.test(message)) {
                const again = await this.client.d1.database.list({ account_id: this.id });
                const raced = again.result.find(db => db.name === SHARED_DB_NAME);
                if (raced?.uuid && raced.name) return { id: raced.uuid, name: raced.name, created: false };
            }

            if (!/limit reached|databases per account|quota/i.test(message)) throw error;

            // Fall back to the oldest database. Prefer one the panel line
            // already owns, so the wizard's and panels' rows live together
            // rather than in a random user database.
            const reuse = existing.result.find(db => db.uuid && db.name?.endsWith('-zagrooo')) ?? existing.result.find(db => db.uuid && db.name);
            if (!reuse?.uuid || !reuse.name) {
                throw new Error('This account is at the D1 database limit and has no existing database to reuse. Delete one, or upgrade the plan.');
            }

            return { id: reuse.uuid, name: reuse.name, created: false };
        }
    }

    async getWorkersDevSubdomain(): Promise<string> {
        const res = await this.client.workers.subdomains.get({ account_id: this.id });
        return `${res.subdomain}.workers.dev`;
    }

    /** The account's workers.dev subdomain, created on first use. */
    async workersDevSubdomain(): Promise<string> {
        try {
            return await this.getWorkersDevSubdomain();
        } catch (error) {
            return await this.createWorkersDevSubdomain();
        }
    }

    async createWorkersDevSubdomain(): Promise<string> {
        const maxAttempts = 3;

        for (let i = 0; i < maxAttempts; i++) {
            try {
                const res = await this.client.workers.subdomains.update({
                    account_id: this.id,
                    subdomain: randSubdomain(),
                });
                return `${res.subdomain}.workers.dev`;
            } catch (err) {
                continue;
            }
        }

        throw new Error(`Failed to create a unique workers.dev subdomain after ${maxAttempts} attempts.`);
    }

    async deployWorker(name: string, script: Uploadable, databaseId: string) {
        // The TS SDK has bugs around worker deployments, so this one goes over
        // the REST API directly.
        const date = new Date().toISOString().split('T')[0];
        const metadata = {
            main_module: 'worker.js',
            compatibility_date: date,
            compatibility_flags: ['nodejs_compat'],
            bindings: [{ type: 'd1', name: 'zag_db', id: databaseId }]
        };

        const uploadForm = new FormData();
        uploadForm.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
        uploadForm.append('worker.js', script as File, 'worker.js');

        const res = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${this.id}/workers/scripts/${name}`,
            { method: 'PUT', headers: { 'Authorization': `Bearer ${this.token}` }, body: uploadForm }
        );

        const data = await res.json() as any;
        if (!res.ok || !data.success) {
            throw new Error(`Error deploying worker: ${JSON.stringify(data.errors, null, 2)}`);
        }
    }

    async enableSubdomain(name: string) {
        await this.client.workers.scripts.subdomain.create(name, {
            account_id: this.id,
            enabled: true,
            previews_enabled: true,
        });
    }

    async createPagesProject(name: string, databaseId: string): Promise<string> {
        const date = new Date().toISOString().split('T')[0];

        const project = await this.client.pages.projects.create({
            account_id: this.id,
            name: name,
            production_branch: 'main',
            deployment_configs: {
                production: {
                    browsers: {},
                    compatibility_date: date,
                    compatibility_flags: ['nodejs_compat'],
                    d1_databases: { 'zag_db': { id: databaseId } }
                }
            }
        });

        return project.subdomain ?? '';
    }

    async deployPages(name: string, script: Uploadable) {
        await this.client.pages.projects.deployments.create(name, {
            account_id: this.id,
            branch: 'main',
            manifest: '{}',
            "_worker.js": script
        });
    }
}
