/**
 * ZAGROOO Wizard — local server.
 *
 * api.cloudflare.com sends no Access-Control-Allow-Origin header on
 * token-authenticated requests, so a page opened straight from disk cannot
 * call it: the browser blocks the preflight. This server is the fix. It
 * serves local.html and proxies /cf/* to the Cloudflare API, which makes the
 * calls same-origin from the browser's point of view.
 *
 * Zero dependencies, binds to 127.0.0.1 only, stores nothing. The token goes
 * browser -> this process -> Cloudflare and is never written to disk.
 *
 *   node scripts/local-server.mjs [port]
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { dirname as pathDirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const PAGE = join(__dirname, '../dist/local.html');
const UPSTREAM = 'https://api.cloudflare.com/client/v4';
const PORT = Number(process.argv[2]) || 8787;

/** Headers worth forwarding upstream. Everything else is browser noise. */
const FORWARD = ['authorization', 'content-type'];

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/' || url.pathname === '/local.html') {
        let page;
        try {
            page = readFileSync(PAGE, 'utf8');
        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('local.html is missing. Run: npm run build-local');
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        res.end(page);
        return;
    }

    if (url.pathname.startsWith('/cf/')) {
        const target = `${UPSTREAM}/${url.pathname.slice(4)}${url.search}`;

        const headers = {};
        for (const name of FORWARD) {
            if (req.headers[name]) headers[name] = req.headers[name];
        }

        const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);

        try {
            const upstream = await fetch(target, { method: req.method, headers, body });
            const payload = Buffer.from(await upstream.arrayBuffer());

            res.writeHead(upstream.status, {
                'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
                'Cache-Control': 'no-store'
            });
            res.end(payload);
        } catch (error) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: false,
                errors: [{ message: `Could not reach Cloudflare: ${error.message}` }]
            }));
        }
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
