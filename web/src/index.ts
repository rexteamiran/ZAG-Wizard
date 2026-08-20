import { CFAccount } from "./api";
import { decrypt, encrypt } from "./encryption";
import { randSubdomain } from "./random";
import { buildScript } from "./script";
import { createStreamLogger, StreamLogger } from "./logger";
import { handleManage as handleManageRequest, ManageRequest } from "./handle-manage";
import { seedPanelRecord } from "./seed";

interface Env {
    SECRET: string;
    ASSETS: any;
}

export default {
    async fetch(request: Request, env: Env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/deploy' && request.method === 'POST') {
            const origin = request.headers.get('Origin');
            if (origin !== url.origin) {
                return new Response('Unauthorized context', { status: 403 });
            }

            const logger = createStreamLogger();
            const { readable, success, info, error, close } = logger;

            (async () => {
                try {
                    const key = url.searchParams.get('key');
                    const preRelease = url.searchParams.get('pre-release') === 'true';
                    const formData = await request.formData();
                    const apiToken = key ? await decrypt(key, env.SECRET) : formData.get('apiToken')?.toString().trim() ?? '';
                    const deployType = formData.get('deployType')?.toString() || 'workers';
                    const displayName = formData.get('displayName')?.toString().trim().slice(0, 64) ?? '';
                    const account = await CFAccount.create(apiToken);

                    let workerName: string;
                    do {
                        workerName = randSubdomain();
                    } while (await account.nameTaken(deployType, workerName));

                    info('Installing ZAGROOO Panel...');
                    const namespaceId = await account.createKvNamespace(workerName, deployType);
                    success('KV namespace created successfully!');

                    const d1 = await account.createD1Database(workerName);
                    const databaseId = d1.id;
                    if (databaseId) {
                        success('D1 database created successfully!');
                    } else {
                        error(`D1 not created: ${d1.error}`);
                        info('Falling back to KV accounting (1000 writes/day on the free plan).');
                        info('Fix the token permission and reinstall to get D1.');
                    }

                    if (deployType === 'pages') {
                        await deployPages(env, account, workerName, namespaceId, databaseId, logger, preRelease, displayName);
                    } else {
                        await deployWorkers(env, account, workerName, namespaceId, databaseId, logger, preRelease, displayName);
                    }
                } catch (err) {
                    error(`Failed to install ZAGROOO Panel: ${err}`);
                } finally {
                    close();
                }
            })();

            return new Response(readable, {
                headers: {
                    'Content-Type': 'application/x-ndjson'
                }
            });
        }


        if (url.pathname.startsWith('/api/manage/')) {
            const origin = request.headers.get('Origin');
            if (origin !== url.origin) {
                return new Response('Unauthorized context', { status: 403 });
            }

            return handleManage(request, env, url);
        }

        if (url.pathname === '/dashboard') {
            return env.ASSETS.fetch(new URL('/dashboard.html', request.url));
        }

        if (url.pathname === '/') {
            return env.ASSETS.fetch(new URL('/index.html', request.url));
        }

        return env.ASSETS.fetch(request);
    }
};

async function deployPages(
    env: Env,
    account: CFAccount,
    workerName: string,
    namespaceId: string,
    databaseId: string,
    logger: StreamLogger,
    preRelease: boolean,
    displayName: string,
) {
    const { success, error, complete } = logger;

    const { script, path } = await buildScript(account, workerName, 'pages.dev', '_worker.js', preRelease);
    success('Script built successfully!');

    const subdomain = await account.createPagesProject(workerName, namespaceId, databaseId);
    success('Pages project created successfully!');

    await account.deployPages(workerName, script);
    success('Pages deployed successfully!');

    // Write the panel's record now, so it is manageable from the dashboard
    // before anyone opens it, and its links are known without guesswork.
    let portal = '';
    try {
        const record = await seedPanelRecord(account.token, account.id, namespaceId, databaseId, {
            displayName,
            panelHost: subdomain,
            panelPath: path
        });
        portal = `https://${subdomain}/${path}/sub/${record.subToken}`;
        success('Panel record created!');
    } catch (err) {
        error(`Could not write the panel record: ${err}`);
    }

    const url = new URL(`https://${subdomain}/${path}/panel`);
    const payload = {
        url: url.href,
        portal,
        name: displayName,
        user: account.email,
        key: await encrypt(account.token, env.SECRET)
    }

    complete(JSON.stringify(payload));
}

async function deployWorkers(
    env: Env,
    account: CFAccount,
    workerName: string,
    namespaceId: string,
    databaseId: string,
    logger: StreamLogger,
    preRelease: boolean,
    displayName: string
) {
    const { success, error, complete } = logger;
    let subdomain: string;
    try {
        subdomain = await account.getWorkersDevSubdomain();
        success('Account workers subdomain is available!');
    } catch (error) {
        subdomain = await account.createWorkersDevSubdomain();
        success('Fresh account, Workers subdomain created successfully!');
    }

    const { script, path } = await buildScript(account, workerName, subdomain, 'worker.js', preRelease);
    success('Script built successfully!');

    await account.deployWorker(workerName, script, namespaceId, databaseId);
    success('Worker deployed successfully!');

    await account.enableSubdomain(workerName);
    success('Worker subdomain enabled successfully!');

    const host = `${workerName}.${subdomain}`;

    let portal = '';
    try {
        const record = await seedPanelRecord(account.token, account.id, namespaceId, databaseId, {
            displayName,
            panelHost: host,
            panelPath: path
        });
        portal = `https://${host}/${path}/sub/${record.subToken}`;
        success('Panel record created!');
    } catch (err) {
        error(`Could not write the panel record: ${err}`);
    }

    const url = new URL(`https://${host}/${path}/panel`);
    const payload = {
        url: url.href,
        portal,
        name: displayName,
        user: account.email,
        key: await encrypt(account.token, env.SECRET)
    }

    complete(JSON.stringify(payload));
}

/* ==========================================================================
   Panel management API

   The request handling lives in handle-manage.ts so the local edition runs
   exactly the same code. This layer only supplies the token: either the
   `key` handed out at install time (encrypted with env.SECRET so it never
   travels in the clear) or a token typed into the dashboard.
   ========================================================================== */

async function handleManage(request: Request, env: Env, url: URL): Promise<Response> {
    if (request.method !== 'POST') {
        return json({ success: false, message: 'Method not allowed.' }, 405);
    }

    const action = url.pathname.replace('/api/manage/', '');
    const body = await request.json().catch(() => ({})) as ManageRequest;

    const result = await handleManageRequest(action, body, async payload =>
        payload.key ? await decrypt(payload.key, env.SECRET) : (payload.token ?? '')
    );

    return json(result.payload, result.status);
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
