import { accountUsage, PanelManager, PanelSummary, ProfileStore, ZagiroProfile } from './manage';
import { CFAccount } from './api';

/* ==========================================================================
   Management request handling

   Shared by both editions. The hosted wizard serves this from the worker; the
   local edition serves the very same module from scripts/local-server.mjs.
   Keeping one implementation means the local edition cannot quietly fall
   behind the hosted one.
   ========================================================================== */

export interface ManageRequest {
    key?: string;
    token?: string;
    panel?: PanelSummary;
    patch?: Record<string, unknown>;
    reason?: string;
    scope?: 'all' | 'daily';
    paused?: boolean;
    profile?: Partial<ZagiroProfile>;
    id?: string;
}

export interface ManageResult {
    status: number;
    payload: { success: boolean; message?: string; body?: unknown };
}

function ok(body?: unknown, message?: string): ManageResult {
    return { status: 200, payload: { success: true, message, body } };
}

function fail(status: number, message: string): ManageResult {
    return { status, payload: { success: false, message } };
}

function requirePanel(body: ManageRequest): PanelSummary {
    if (!body.panel?.name || !body.panel?.deployType) {
        throw new Error('Missing panel reference.');
    }

    return body.panel;
}

/**
 * @param resolveToken turns the request into a Cloudflare API token. The
 * hosted wizard decrypts its private-link key here; the local edition only
 * accepts a token typed in directly.
 */
export async function handleManage(
    action: string,
    body: ManageRequest,
    resolveToken: (body: ManageRequest) => Promise<string>
): Promise<ManageResult> {
    let token: string;

    try {
        token = (await resolveToken(body)).trim();
    } catch (error) {
        return fail(401, error instanceof Error ? error.message : String(error));
    }

    if (!token) return fail(401, 'Missing Cloudflare API token.');

    try {
        const account = await CFAccount.create(token);
        const manager = new PanelManager(token, account.id);

        switch (action) {
            case 'account':
                return ok({ email: account.email, id: account.id });

            case 'panels':
                return ok({ panels: await manager.listPanels() });

            case 'detail':
                return ok(await manager.panelDetail(requirePanel(body)));

            case 'limits': {
                const limits = await manager.updateLimits(requirePanel(body), body.patch ?? {});
                return ok({ limits }, 'Limits updated.');
            }

            case 'pause': {
                const paused = body.paused !== false;
                await manager.setPaused(requirePanel(body), paused, body.reason);
                return ok(undefined, paused ? 'Panel paused.' : 'Panel resumed.');
            }

            case 'reset-usage':
                await manager.resetUsage(requirePanel(body), body.scope === 'daily' ? 'daily' : 'all');
                return ok(undefined, 'Usage reset.');

            case 'delete':
                await manager.deletePanel(requirePanel(body));
                return ok(undefined, 'Panel deleted.');

            case 'account-usage':
                return ok(await accountUsage(token, account.id));

            case 'repair': {
                const fixed = await manager.repairPanel(requirePanel(body));
                return ok(fixed, 'Links repaired.');
            }

            case 'update-panel': {
                const panel = requirePanel(body);
                await manager.updatePanel(panel);
                return ok(undefined, `${panel.name} updated.`);
            }

            case 'add-d1': {
                const databaseId = await manager.addD1(requirePanel(body));
                return ok({ databaseId }, 'D1 database attached.');
            }

            case 'health':
                return ok(await manager.healthCheck(requirePanel(body)));

            case 'read-settings':
                return ok({ settings: await manager.readSettings(requirePanel(body)) });

            case 'apply-profile': {
                if (!body.profile) return fail(400, 'Missing profile.');
                const report = await manager.applyProfile(requirePanel(body), body.profile);
                return ok(report, 'Profile applied.');
            }

            case 'profiles':
                return ok({ profiles: await new ProfileStore(token, account.id).list() });

            case 'profile-save': {
                if (!body.profile) return fail(400, 'Missing profile.');
                const saved = await new ProfileStore(token, account.id).save(body.profile);
                return ok({ profile: saved }, 'Profile saved.');
            }

            case 'profile-delete': {
                if (!body.id) return fail(400, 'Missing profile id.');
                await new ProfileStore(token, account.id).remove(body.id);
                return ok(undefined, 'Profile deleted.');
            }

            default:
                return fail(404, `Unknown action: ${action}`);
        }
    } catch (error) {
        return fail(500, error instanceof Error ? error.message : String(error));
    }
}
