/* ==========================================================================
   Event log

   The wizard records what it does and what fails — installs and their
   outcomes, sign-ins and their failures, requests that die. The /log page
   shows the newest first, so an operator debugging a problem reads the actual
   recorded reason instead of guessing.

   A rolling window in the wizard's own D1: oldest rows fall off past the cap,
   and recording never throws — a failing request must not be made worse by
   its own logging.
   ========================================================================== */

import { ensureSchema } from './db';

const MAX_EVENTS = 300;

export interface WizardEvent {
    ts: number;
    level: 'info' | 'warn' | 'error';
    source: string;
    message: string;
    detail: string;
}

export async function recordEvent(
    env: Env,
    source: string,
    message: string,
    detail: string = '',
    level: WizardEvent['level'] = 'error'
): Promise<void> {
    try {
        await ensureSchema(env.db);
        await env.db.prepare(
            `INSERT INTO wizard_log (ts, level, source, message, detail)
             SELECT ?, ?, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM wizard_log) < ?`,
        ).bind(Date.now(), level, source.slice(0, 40), String(message).slice(0, 500), String(detail).slice(0, 2000), MAX_EVENTS).run();

        // Trim the oldest rows once the window has filled up. One delete per
        // event keeps the table bounded without any scheduled job.
        await env.db.prepare(
            `DELETE FROM wizard_log WHERE ts <= (
                 SELECT MIN(ts) FROM (
                     SELECT ts FROM wizard_log ORDER BY ts DESC LIMIT ?
                 )
             )`
        ).bind(MAX_EVENTS).run();
    } catch (error) {
        console.log('Could not record the event:', error);
    }
}

export async function listEvents(env: Env): Promise<WizardEvent[]> {
    await ensureSchema(env.db);

    const result = await env.db.prepare(
        'SELECT ts, level, source, message, detail FROM wizard_log ORDER BY ts DESC LIMIT ?'
    ).bind(MAX_EVENTS).all<WizardEvent>();

    return (result.results ?? []) as WizardEvent[];
}

export async function clearEvents(env: Env): Promise<void> {
    await ensureSchema(env.db);
    await env.db.prepare('DELETE FROM wizard_log').run();
}
