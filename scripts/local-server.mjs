/**
 * ZAGROOO Wizard — local server.
 *
 * Serves dist/local.html and the same /api/manage/* endpoints the hosted
 * wizard exposes, running the identical bundled logic from dist/manage.mjs.
 * That means the local edition can never quietly fall behind the hosted one.
 *
 * A browser cannot call api.cloudflare.com directly — it sends no
 * Access-Control-Allow-Origin header on token-authenticated requests — so the
 * work happens here instead.
 *
 * Zero runtime dependencies, binds to 127.0.0.1 only, stores nothing. The
 * token goes browser -> this process -> Cloudflare and is never written to disk.
 *
 *   node scripts/local-server.mjs [port]
 */
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { dirname as pathDirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const PAGE = join(__dirname, '../dist/local.html');
const BUNDLE = join(__dirname, '../dist/manage.mjs');
const PORT = Number(process.argv[2]) || 8787;

if (!existsSync(PAGE) || !existsSync(BUNDLE)) {
    console.error('\n  dist/ is missing. Build it first:\n\n    npm run build-local\n');
    process.exit(1);
}

const { handleManage } = await import(`file://${BUNDLE.replace(/\\/g, '/')}`);

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/' || url.pathname === '/local.html') {
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(readFileSync(PAGE, 'utf8'));
        return;
    }

    if (url.pathname.startsWith('/api/manage/')) {
        if (req.method !== 'POST') {
            sendJson(res, 405, { success: false, message: 'Method not allowed.' });
            return;
        }

        const action = url.pathname.replace('/api/manage/', '');

        let body = {};
        try {
            body = JSON.parse(await readBody(req) || '{}');
        } catch (error) {
            sendJson(res, 400, { success: false, message: 'Invalid JSON body.' });
            return;
        }

        // Private install links are encrypted with the hosted worker's secret,
        // which this process does not have.
        const result = await handleManage(action, body, async payload => {
            if (payload.key) {
                throw new Error('Private install links only work in the hosted wizard. Paste an API token here instead.');
            }
            return payload.token ?? '';
        });

        sendJson(res, result.status, result.payload);
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('');
    console.log('  ZAGROOO Wizard — local edition');
    console.log(`  http://127.0.0.1:${PORT}`);
    console.log('');
    console.log('  Paste a Cloudflare API token in the page to connect.');
    console.log('  Nothing is stored. Ctrl+C to stop.');
    console.log('');
});
