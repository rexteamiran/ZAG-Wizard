/**
 * Builds the local edition:
 *
 *   dist/manage.mjs   the management logic, bundled from web/src so the local
 *                     server runs exactly the same code as the hosted worker
 *   dist/local.html   the dashboard, inlined into one file
 *
 * The page talks to the local server's /api/manage/* endpoints, identical to
 * the hosted wizard's, so dashboard.js needs no local-only branch.
 *
 * Output goes to dist/, never web/assets/: anything under web/assets is served
 * publicly by the deployed worker, and this page only works behind the local
 * server.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname as pathDirname, join } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '../web/assets');
const SRC = join(__dirname, '../web/src');
const DIST = join(__dirname, '../dist');

const read = name => readFileSync(join(ASSETS, name), 'utf8');

mkdirSync(DIST, { recursive: true });

// ---- 1. bundle the shared management code for Node -------------------------
await build({
    entryPoints: [join(SRC, 'handle-manage.ts')],
    outfile: join(DIST, 'manage.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'warning'
});

console.log('✔ dist/manage.mjs built');

// ---- 2. inline the dashboard into one page ---------------------------------
const theme = read('theme.css');
const dashboardCss = read('dashboard.css');
const dashboardJs = read('dashboard.js');
const templatesJs = read('templates.js');

let html = read('dashboard.html');

html = html
    .replace('<title>ZAGROOO Wizard — Panels</title>', '<title>ZAGROOO Wizard — Local</title>')
    .replace('<link rel="icon" href="favicon.ico" />', '')
    .replace('<link href="theme.css" rel="stylesheet" />', `<style>\n${theme}\n</style>`)
    .replace('<link href="dashboard.css" rel="stylesheet" />', `<style>\n${dashboardCss}\n</style>`)
    .replace('<script src="templates.js"></script>', `<script>\n${templatesJs}\n</script>`)
    .replace('<script src="dashboard.js"></script>', `<script>\n${dashboardJs}\n</script>`)
    // No worker behind this page, so the install flow lives elsewhere and
    // private install links (which only the worker can decrypt) do not apply.
    .replace('<a class="btn btn-ghost" href="/">Install a panel</a>', '')
    .replace(
        'Paste the API token the wizard used to install your panels, or use the private link',
        'Paste the API token the wizard used to install your panels.')
    .replace('you were given after an install. The token is used for this session only and is never stored.',
        'The token is used for this session only and is never stored.');

const banner = `<!--
  ZAGROOO Wizard, local edition.

  Serve it with:  npm run local     then open http://127.0.0.1:8787

  Opening this file straight from disk will NOT work. It needs the local
  server, which runs the management logic and reaches the Cloudflare API on
  the page's behalf - the browser cannot call that API directly because it
  sends no CORS headers for token-authenticated requests.

  Nothing is uploaded anywhere. The token goes browser -> local server ->
  Cloudflare and is never written to disk.

  Use a token scoped to Workers Scripts Edit, Workers KV Storage Edit, D1 Edit,
  Pages Edit, Account Analytics Read and User Details Read. Never a Global API Key.
-->
`;

writeFileSync(join(DIST, 'local.html'), banner + html, 'utf8');
console.log('✔ dist/local.html built — serve it with: npm run local');
