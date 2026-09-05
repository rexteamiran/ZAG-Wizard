/**
 * Pure dashboard-input logic:
 *  - password hashing must round-trip and reject wrong or tampered passwords
 *  - panel addresses typed by hand must land on the panel's API root
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function bundle(entryPoint) {
    const result = await build({
        entryPoints: [join(root, entryPoint)],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        logLevel: 'silent'
    });

    return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const auth = await bundle('web/src/auth.ts');
const api = await bundle('web/src/api.ts');

test('a password round-trips through the hash', async () => {
    const hash = await auth.hashPassword('correct horse battery staple');
    assert.notEqual(hash, 'correct horse battery staple', 'the password was stored in the clear');
    assert.equal(await auth.verifyPassword('correct horse battery staple', hash), true);
});

test('a wrong password is rejected', async () => {
    const hash = await auth.hashPassword('hunter2hunter2');
    assert.equal(await auth.verifyPassword('hunter2hunter3', hash), false);
    assert.equal(await auth.verifyPassword('', hash), false);
});

test('salts differ between hashes of the same password', async () => {
    const a = await auth.hashPassword('same-password');
    const b = await auth.hashPassword('same-password');
    assert.notEqual(a, b, 'two accounts with one password share a hash');
});

test('a tampered hash fails closed', async () => {
    const hash = await auth.hashPassword('anything');
    assert.equal(await auth.verifyPassword('anything', hash.slice(0, -2) + 'zz'), false);
    assert.equal(await auth.verifyPassword('anything', 'not-a-hash'), false);
});

test('panel addresses normalise to the API root', () => {
    const cases = [
        ['https://zag1.example.workers.dev/aBcD123/panel', 'https://zag1.example.workers.dev/aBcD123/api'],
        ['https://zag1.example.workers.dev/aBcD123', 'https://zag1.example.workers.dev/aBcD123/api'],
        ['zag1.example.workers.dev/aBcD123', 'https://zag1.example.workers.dev/aBcD123/api'],
        ['https://zag2.pages.dev', 'https://zag2.pages.dev/api'],
        ['https://panel.example.com/sp/api/', 'https://panel.example.com/sp/api']
    ];

    for (const [input, expected] of cases) {
        assert.equal(api.normaliseApiUrl(input), expected, `normalisation broke for ${input}`);
    }
});

test('an empty address stays empty, so validation can reject it', () => {
    assert.equal(api.normaliseApiUrl('   '), '');
});
