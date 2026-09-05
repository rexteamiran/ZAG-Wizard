/* ==========================================================================
   Install pipeline — single and group

   A group install creates N panels at once: zag1..zag20 by default, or
   Prefix-1..Prefix-N when a display name is given. The naming counter is
   global per account (stored in the wizard's own D1), so the next install
   continues where the last one stopped instead of colliding.

   Every panel binds the account's one shared D1 database, and every panel
   gets an API key seeded at install so the dashboard can manage it without a
   Cloudflare token.
   ========================================================================== */

import { CFAccount, SHARED_DB_NAME } from './cf';
import { buildScript } from './script';
import { seedPanelRecord } from './seed';
import { ensureSchema, takeCounter } from './db';
import { StreamLogger } from './logger';

const MAX_GROUP = 20;

export interface InstallRequest {
    token: string;
    deployType: string;
    displayName: string;
    count: number;
    preRelease: boolean;
}

export interface InstallResult {
    name: string;
    url: string;
    portal: string;
    apiKey: string;
    error?: string;
}

export async function installPanels(
    env: Env,
    account: CFAccount,
    request: InstallRequest,
    logger: StreamLogger
): Promise<InstallResult[]> {
    const { success, info, error } = logger;
    const count = Math.max(1, Math.min(MAX_GROUP, Math.floor(request.count) || 1));

    await ensureSchema(env.db);

    // Claim the display names before creating anything, so two installs
    // running side by side cannot grab the same names.
    const prefix = (request.displayName || 'zag').replace(/[^\w-]/g, '').slice(0, 40) || 'zag';
    const start = await takeCounter(env.db, `${account.id}:${prefix}`, count);

    const sharedDb = await account.findOrCreateSharedDatabase();
    if (sharedDb.created) {
        success(`Shared database ${sharedDb.name} created!`);
    } else if (sharedDb.name === SHARED_DB_NAME) {
        info(`Using the existing shared database ${sharedDb.name}.`);
    } else {
        // The account was at Cloudflare's ten-database cap, so an older
        // database was reused. Panels namespace their rows, so this is safe.
        info(`The account is at the D1 limit — reusing database ${sharedDb.name} for all panels.`);
    }

    if (count > 1) {
        info(request.displayName
            ? `Installing ${count} panels: ${prefix}-${start} to ${prefix}-${start + count - 1}.`
            : `Installing ${count} panels: ${prefix}${start} to ${prefix}${start + count - 1}.`);
    }

    const results: InstallResult[] = [];

    for (let i = 0; i < count; i++) {
        const displayName = request.displayName ? `${prefix}-${start + i}` : `${prefix}${start + i}`;
        results.push(await installOne(account, request, sharedDb.id, displayName, logger));
    }

    if (results.every(r => !r.error)) {
        success(`${count} panel${count === 1 ? '' : 's'} installed.`);
    } else {
        const failed = results.filter(r => r.error).length;
        error(`${count - failed} done, ${failed} failed — see the log above.`);
    }

    return results;
}

async function installOne(
    account: CFAccount,
    request: InstallRequest,
    databaseId: string,
    displayName: string,
    logger: StreamLogger
): Promise<InstallResult> {
    const { success, error } = logger;
    const result: InstallResult = { name: displayName, url: '', portal: '', apiKey: '' };

    try {
        const isPages = request.deployType === 'pages';

        let workerName: string;
        do {
            workerName = randWorkerName(displayName);
        } while (await account.nameTaken(request.deployType, workerName));

        // Workers deploy under <name>.<account-subdomain>; Pages under
        // <project>.pages.dev, where the project name is the worker name.
        const subdomain = isPages ? 'pages.dev' : await account.workersDevSubdomain();

        const { script, path } = await buildScript(
            account, workerName, subdomain,
            isPages ? '_worker.js' : 'worker.js',
            request.preRelease, databaseId
        );
        success(`${displayName}: script built!`);

        let host: string;
        if (isPages) {
            const projectSubdomain = await account.createPagesProject(workerName, databaseId);
            await account.deployPages(workerName, script);
            host = projectSubdomain || `${workerName}.pages.dev`;
            success(`${displayName}: Pages deployed!`);
        } else {
            await account.deployWorker(workerName, script, databaseId);
            await account.enableSubdomain(workerName);
            host = `${workerName}.${subdomain}`;
            success(`${displayName}: Worker deployed!`);
        }

        const { record, apiKey } = await seedPanelRecord(account.token, account.id, databaseId, {
            displayName,
            panelHost: host,
            panelPath: path,
            panelId: workerName
        });
        success(`${displayName}: panel record and Dashboard API key created!`);

        result.url = `https://${host}/${path}/panel`;
        result.portal = `https://${host}/${path}/sub/${record.subToken}`;
        result.apiKey = apiKey;

        return result;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        error(`${displayName} failed: ${message}`);
        result.error = message;
        return result;
    }
}

/** Keeps worker names readable and unique without carrying the display name raw. */
function randWorkerName(displayName: string): string {
    const base = displayName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'zag';
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${base}-${suffix}`;
}
