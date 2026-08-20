/**
 * Builds web/assets/local.html: the hosted dashboard, inlined into one file
 * that runs straight from disk with no server. The UI and the management
 * logic are the same sources as the hosted edition; only the transport
 * differs, and cf-client.js supplies that.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname as pathDirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = pathDirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '../web/assets');
// Built into dist/, not web/assets/: anything under web/assets is served
// by the deployed worker, and this page only works behind the local
// server's /cf proxy.
const DIST = join(__dirname, '../dist');

const read = name => readFileSync(join(ASSETS, name), 'utf8');

const theme = read('theme.css');
const dashboardCss = read('dashboard.css');
const cfClient = read('cf-client.js');
const dashboardJs = read('dashboard.js');

let html = read('dashboard.html');

html = html
    .replace('<title>ZAGROOO Wizard — Panels</title>', '<title>ZAGROOO Wizard — Local</title>')
    .replace('<link rel="icon" href="favicon.ico" />', '')
    .replace('<link href="theme.css" rel="stylesheet" />', `<style>\n${theme}\n</style>`)
    .replace('<link href="dashboard.css" rel="stylesheet" />', `<style>\n${dashboardCss}\n</style>`)
    // The page is served by scripts/local-server.mjs, which proxies /cf/* to
    // the Cloudflare API. Going direct is impossible: the API sends no CORS
    // headers for token-authenticated requests, so the browser blocks it.
    .replace('<script src="dashboard.js"></script>',
        `<script>window.ZAG_CF_PROXY = '/cf';</script>\n<script>\n${cfClient}\n</script>\n<script>\n${dashboardJs}\n</script>`)
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

  Opening this file straight from disk will NOT work. api.cloudflare.com sends
  no Access-Control-Allow-Origin header on token-authenticated requests, so the
  browser blocks every call. scripts/local-server.mjs proxies them same-origin.

  Nothing is uploaded anywhere. The token goes browser -> local server ->
  Cloudflare and is never written to disk.

  Use a token scoped to Workers Scripts Edit, Workers KV Storage Edit, D1 Edit,
  Pages Edit, Account Settings Read and User Details Read. Never a Global API Key.
-->
`;

mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'local.html'), banner + html, 'utf8');
console.log('✔ dist/local.html built — serve it with: npm run local');
