/* ==========================================================================
   ZAGROOO Wizard — worker

   Three faces:

     /            the install page (open; brings its own Cloudflare token)
     /login       account gate for the dashboard
     /dashboard   manage every panel through each panel's own API

   The worker itself holds no panel traffic: it stores accounts, sessions,
   connections and profiles in its own D1 database, streams install logs, and
   serves the static UI. Panel management happens browser -> panel API, so
   managing a hundred panels costs the wizard no request quota at all.
   ========================================================================== */

import { CFAccount } from './cf';
import { installPanels } from './install';
import { createStreamLogger } from './logger';
import {
    sessionOf, handleAuth, json
} from './auth';
import { recordEvent, listEvents, clearEvents } from './eventlog';
import {
    addConnection, deleteConnection, listConnections, updateConnection,
    listProfiles, saveProfile, deleteProfile
} from './api';

interface Env {
    SECRET: string;
    db: D1Database;
    WIZARD_INVITE_CODE?: string;
    ASSETS: any;
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/api/auth/')) {
            return handleAuth(request, env);
        }

        if (url.pathname === '/api/install' && request.method === 'POST') {
            return handleInstall(request, env);
        }

        // Everything below needs a signed-in user.
        const session = await sessionOf(request, env);

        if (url.pathname.startsWith('/api/')) {
            if (!session) return json({ success: false, message: 'Sign in first.' }, 401);
            return handleApi(request, env, session);
        }

        if (url.pathname === '/dashboard') {
            if (!session) {
                return Response.redirect(new URL('/login', url.origin).href, 302);
            }
            return serve(env, request, 'dashboard.html');
        }

        if (url.pathname === '/log') {
            if (!session) {
                return Response.redirect(new URL('/login', url.origin).href, 302);
            }
            return serve(env, request, 'log.html');
        }

        if (url.pathname === '/login') {
            if (session) {
                return Response.redirect(new URL('/dashboard', url.origin).href, 302);
            }
            return serve(env, request, 'login.html');
        }

        if (url.pathname === '/') {
            return serve(env, request, 'index.html');
        }

        return env.ASSETS.fetch(request);
    }
};

function serve(env: Env, request: Request, page: string): Promise<Response> {
    return env.ASSETS.fetch(new URL(`/${page}`, request.url));
}

/* ------------------------------------------------------------------ routes */

async function handleApi(request: Request, env: Env, session: { userId: string; email: string }): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname.replace(/^\/api\/?/, '');
    const body = await request.json().catch(() => ({})) as Record<string, any>;

    try {
        switch (true) {
            case route === 'me':
                return json({ success: true, body: { email: session.email } });

            case route === 'log':
                // The log page clears with DELETE /api/log.
                if (request.method === 'DELETE') {
                    await clearEvents(env);
                    return json({ success: true, message: 'Log cleared.' });
                }
                return json({ success: true, body: { events: await listEvents(env) } });

            case route === 'log/clear':
                await clearEvents(env);
                return json({ success: true, message: 'Log cleared.' });

            case route === 'connections':
                return json({ success: true, body: { connections: await listConnections(env, session.userId) } });

            case route === 'connections/add':
                return json({ success: true, body: { connection: await addConnection(env, session.userId, body) } });

            case route === 'connections/update':
                await updateConnection(env, session.userId, String(body.id ?? ''), body);
                return json({ success: true, message: 'Connection updated.' });

            case route === 'connections/delete':
                await deleteConnection(env, session.userId, String(body.id ?? ''));
                return json({ success: true, message: 'Connection removed.' });

            case route === 'profiles':
                return json({ success: true, body: { profiles: await listProfiles(env, session.userId) } });

            case route === 'profiles/save':
                return json({ success: true, body: { profile: await saveProfile(env, session.userId, body.profile ?? {}) } });

            case route === 'profiles/delete':
                await deleteProfile(env, session.userId, String(body.id ?? ''));
                return json({ success: true, message: 'Profile deleted.' });

            default:
                return json({ success: false, message: `Unknown route: ${route}` }, 404);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordEvent(env, `api:${route}`, message, `User: ${session.email}`, 'error');
        return json({ success: false, message }, 400);
    }
}

/* ----------------------------------------------------------------- install */

/**
 * Streams NDJSON install events. Open to anyone with a Cloudflare token —
 * the install page has no account. The final `complete` event carries every
 * installed panel's links and Dashboard API key.
 */
async function handleInstall(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) {
        return json({ success: false, message: 'Unauthorized context.' }, 403);
    }

    const logger = createStreamLogger();
    const { readable, info, success, error, complete, close } = logger;

    (async () => {
        try {
            const formData = await request.formData();
            const apiToken = formData.get('apiToken')?.toString().trim() ?? '';
            const deployType = formData.get('deployType')?.toString() || 'workers';
            const displayName = formData.get('displayName')?.toString().trim().slice(0, 40) ?? '';
            const count = parseInt(formData.get('count')?.toString() || '1', 10) || 1;
            const preRelease = formData.get('preRelease')?.toString() === 'true';

            if (!apiToken) throw new Error('Missing Cloudflare API token.');

            const account = await CFAccount.create(apiToken);
            info(`Signed in as ${account.email}.`);

            const results = await installPanels(env, account, {
                token: apiToken, deployType, displayName, count, preRelease
            }, logger);

            // Failed panels are streamed above; recording them here means the
            // /log page keeps the whole story after the browser tab is gone.
            for (const result of results.filter(r => r.error)) {
                await recordEvent(env, 'install', `${result.name}: ${result.error}`, `Account: ${account.email}`, 'error');
            }
            if (results.some(r => !r.error)) {
                await recordEvent(env, 'install',
                    `${results.filter(r => !r.error).length} panel(s) installed`,
                    `Account: ${account.email} · ${deployType}`, 'info');
            }

            complete(JSON.stringify({ user: account.email, results }));
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await recordEvent(env, 'install', message, 'Install failed before any panel was created.', 'error');
            error(`Install failed: ${message}`);
        } finally {
            close();
        }
    })();

    return new Response(readable, {
        headers: { 'Content-Type': 'application/x-ndjson' }
    });
}
