/* ==========================================================================
   Accounts and sessions

   Registration is gated by an invite code: the operator sets
   WIZARD_INVITE_CODE as a deploy secret, and only people holding it can
   create an account. With no secret set, registration is closed but login
   keeps working. Passwords are PBKDF2-hashed; sessions are random tokens,
   stored hashed, seven-day expiry, HttpOnly cookie.
   ========================================================================== */

import { ensureSchema, query, run } from './db';
import { recordEvent } from './eventlog';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'wizard_session';

const PBKDF2_ITERATIONS = 100_000;

export interface UserRow {
    id: string;
    email: string;
    pass: string;
    created_at: number;
}

function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

export async function sha256(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomUUID().replaceAll('-', '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        key,
        256
    );
    const hash = Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
    return `pbkdf2:${PBKDF2_ITERATIONS}:${salt}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [scheme, iterations, salt, hash] = stored.split(':');
    if (scheme !== 'pbkdf2') return false;

    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: Number(iterations) || PBKDF2_ITERATIONS, hash: 'SHA-256' },
        key,
        256
    );
    const candidate = Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
    return constantTimeEqual(candidate, hash);
}

/* ----------------------------------------------------------------- login wall */

export interface Session {
    userId: string;
    email: string;
}

/**
 * Resolves the signed-in user from the request cookie, or null. Reads on
 * every dashboard request, so it does as little work as possible.
 */
export async function sessionOf(request: Request, env: Env): Promise<Session | null> {
    const cookie = request.headers.get('Cookie') ?? '';
    const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (!match) return null;

    const tokenHash = await sha256(match[1]);
    const rows = await query<{ user_id: string; email: string; expires_at: number }>(
        env.db,
        `SELECT s.user_id, s.expires_at, u.email
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
        [tokenHash]
    );

    const row = rows[0];
    if (!row || row.expires_at < Date.now()) return null;

    return { userId: row.user_id, email: row.email };
}

export function sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}

export function clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

async function createSession(env: Env, userId: string): Promise<string> {
    const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

    // Sessions are only ever inserted, so piggyback a purge of the expired
    // ones here — one DELETE per login keeps the table from growing forever.
    await Promise.all([
        run(
            env.db,
            'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
            [await sha256(token), userId, Date.now() + SESSION_TTL_MS]
        ),
        run(env.db, 'DELETE FROM sessions WHERE expires_at < ?', [Date.now()])
    ]);

    return token;
}

/* ------------------------------------------------------------- rate limiting */

const attempts = new Map<string, { count: number; windowStart: number }>();

function loginLimited(ip: string): boolean {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;

    if (attempts.size > 1000) {
        for (const [key, value] of attempts) {
            if (now - value.windowStart > windowMs) attempts.delete(key);
        }
    }

    const record = attempts.get(ip);
    if (!record || now - record.windowStart > windowMs) {
        attempts.set(ip, { count: 1, windowStart: now });
        return false;
    }

    record.count += 1;
    return record.count > 20;
}

/* -------------------------------------------------------------------- routes */

export function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json', ...headers }
    });
}

export async function handleAuth(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return json({ success: false, message: 'Method not allowed.' }, 405);
    }

    try {
        await ensureSchema(env.db);

        const action = new URL(request.url).pathname.split('/').pop() ?? '';
        const body = await request.json().catch(() => ({})) as Record<string, any>;

        if (action === 'register') {
            return await register(request, env, body);
        }

        if (action === 'login') {
            return await login(request, env, body);
        }

        if (action === 'logout') {
            const session = await sessionOf(request, env);
            if (session) {
                const cookie = request.headers.get('Cookie') ?? '';
                const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
                if (match) {
                    await run(env.db, 'DELETE FROM sessions WHERE token_hash = ?', [await sha256(match[1])]);
                }
            }
            return json({ success: true }, 200, { 'Set-Cookie': clearSessionCookie() });
        }

        return json({ success: false, message: 'Unknown action.' }, 404);
    } catch (error) {
        return json({ success: false, message: error instanceof Error ? error.message : String(error) }, 500);
    }
}

async function register(request: Request, env: Env, body: Record<string, any>): Promise<Response> {
    const email = String(body.email ?? '').trim().toLowerCase();
    const invite = (env.WIZARD_INVITE_CODE ?? '').trim();
    if (!invite) {
        await recordEvent(env, 'auth', 'Registration attempt while registration is closed', `Email: ${email || '(none)'}`, 'warn');
        return json({ success: false, message: 'Registration is closed. Ask the operator for an account.' }, 403);
    }

    if (!body.invite || !constantTimeEqual(String(body.invite).trim(), invite)) {
        await recordEvent(env, 'auth', 'Registration refused — wrong invite code', `Email: ${email || '(none)'}`, 'warn');
        return json({ success: false, message: 'Wrong invite code.' }, 403);
    }

    const password = String(body.password ?? '');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ success: false, message: 'Enter a valid email address.' }, 400);
    }
    if (password.length < 8) {
        return json({ success: false, message: 'Password must be at least 8 characters.' }, 400);
    }

    const existing = await query(env.db, 'SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
        return json({ success: false, message: 'An account with this email already exists.' }, 409);
    }

    const id = crypto.randomUUID();
    try {
        await run(
            env.db,
            'INSERT INTO users (id, email, pass, created_at) VALUES (?, ?, ?, ?)',
            [id, email, await hashPassword(password), Date.now()]
        );
    } catch (error) {
        // Two registrations racing on one email: the loser hits the UNIQUE
        // constraint. Report it the same friendly way as the check above.
        if (/UNIQUE constraint/i.test(String((error as any)?.message ?? error))) {
            return json({ success: false, message: 'An account with this email already exists.' }, 409);
        }
        throw error;
    }

    const token = await createSession(env, id);
    await recordEvent(env, 'auth', 'Account created', `Email: ${email}`, 'info');
    return json({ success: true, body: { email } }, 200, { 'Set-Cookie': sessionCookie(token) });
}

async function login(request: Request, env: Env, body: Record<string, any>): Promise<Response> {
    const ip = request.headers.get('cf-connecting-ip') ?? 'local';
    if (loginLimited(ip)) {
        return json({ success: false, message: 'Too many attempts, try again later.' }, 429);
    }

    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    const rows = await query<UserRow>(env.db, 'SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];

    // Hash a dummy password when the account does not exist, so a timing
    // side channel does not reveal which emails are registered.
    const stored = user?.pass ?? 'pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';

    if (!user || !(await verifyPassword(password, stored))) {
        await recordEvent(env, 'auth', 'Failed login attempt', `Email: ${email || '(none)'}`, 'warn');
        return json({ success: false, message: 'Wrong email or password.' }, 401);
    }

    const token = await createSession(env, user.id);
    await recordEvent(env, 'auth', 'Signed in', `Email: ${user.email}`, 'info');
    return json({ success: true, body: { email: user.email } }, 200, { 'Set-Cookie': sessionCookie(token) });
}
