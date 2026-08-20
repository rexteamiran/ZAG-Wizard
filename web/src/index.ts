import { CFAccount } from "./api";
import { decrypt, encrypt } from "./encryption";
import { randSubdomain } from "./random";
import { buildScript } from "./script";
import { createStreamLogger, StreamLogger } from "./logger";
import { PanelManager, PanelSummary } from "./manage";

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
                        await deployPages(env, account, workerName, namespaceId, databaseId, logger, preRelease);
                    } else {
                        await deployWorkers(env, account, workerName, namespaceId, databaseId, logger, preRelease);
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
) {
    const { success, complete } = logger;

    const { script, path } = await buildScript(account, workerName, 'pages.dev', '_worker.js', preRelease);
    success('Script built successfully!');

    const subdomain = await account.createPagesProject(workerName, namespaceId, databaseId);
    success('Pages project created successfully!');

    await account.deployPages(workerName, script);
    success('Pages deployed successfully!');

    const url = new URL(`https://${subdomain}/${path}/panel`);
    const payload = {
        url: url.href,
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
    preRelease: boolean
) {
    const { success, complete } = logger;
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

    const url = new URL(`https://${workerName}.${subdomain}/${path}/panel`);
    const payload = {
        url: url.href,
        user: account.email,
        key: await encrypt(account.token, env.SECRET)
    }

    complete(JSON.stringify(payload));
}

/* ==========================================================================
   Panel management API

   Every call carries the Cloudflare token: either the `key` the wizard handed
   out at install time (encrypted with env.SECRET, so it never travels in the
   clear) or a raw token typed into the dashboard. The token is used for that
   request only and is never stored server side.
   ========================================================================== */

interface ManageRequest {
    key?: string;
    token?: string;
    panel?: PanelSummary;
    patch?: Record<string, unknown>;
    reason?: string;
    scope?: 'all' | 'daily';
    paused?: boolean;
}

async function handleManage(request: Request, env: Env, url: URL): Promise<Response> {
    if (request.method !== 'POST') {
        return json({ success: false, message: 'Method not allowed.' }, 405);
    }

    const action = url.pathname.replace('/api/manage/', '');

    try {
        const body = await request.json() as ManageRequest;
        const token = body.key ? await decrypt(body.key, env.SECRET) : (body.token ?? '').trim();
        if (!token) {
            return json({ success: false, message: 'Missing Cloudflare API token.' }, 401);
        }

        const account = await CFAccount.create(token);
        const manager = new PanelManager(token, account.id);

        switch (action) {
            case 'account':
                return json({ success: true, body: { email: account.email, id: account.id } });

            case 'panels':
                return json({ success: true, body: { panels: await manager.listPanels() } });

            case 'detail': {
                const panel = requirePanel(body);
                return json({ success: true, body: await manager.panelDetail(panel) });
            }

            case 'limits': {
                const panel = requirePanel(body);
                const limits = await manager.updateLimits(panel, body.patch ?? {});
                return json({ success: true, message: 'Limits updated.', body: { limits } });
            }

            case 'pause': {
                const panel = requirePanel(body);
                await manager.setPaused(panel, body.paused !== false, body.reason);
                return json({ success: true, message: body.paused === false ? 'Panel resumed.' : 'Panel paused.' });
            }

            case 'reset-usage': {
                const panel = requirePanel(body);
                await manager.resetUsage(panel, body.scope === 'daily' ? 'daily' : 'all');
                return json({ success: true, message: 'Usage reset.' });
            }

            case 'delete': {
                const panel = requirePanel(body);
                await manager.deletePanel(panel);
                return json({ success: true, message: 'Panel deleted.' });
            }

            default:
                return json({ success: false, message: 'Unknown action.' }, 404);
        }
    } catch (error) {
        return json({ success: false, message: String(error instanceof Error ? error.message : error) }, 500);
    }
}

function requirePanel(body: ManageRequest): PanelSummary {
    if (!body.panel?.name || !body.panel?.deployType) {
        throw new Error('Missing panel reference.');
    }

    return body.panel;
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
