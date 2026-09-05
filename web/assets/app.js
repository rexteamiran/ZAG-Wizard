/* ==========================================================================
   ZAGROOO Wizard — install page.

   One token, one form, any number of panels. Each installed panel returns an
   API key for the dashboard's API page; nothing else is kept.
   ========================================================================== */

const deployForm = document.getElementById('deployForm');
const togglePass = document.getElementById('togglePassword');
const out = document.getElementById('output');
const results = document.getElementById('results');

document.addEventListener('DOMContentLoaded', () => {
    const permissions = [
        { key: 'workers_scripts', type: 'edit' },
        // Every panel of the account shares one D1 database.
        { key: 'd1', type: 'edit' },
        { key: 'page', type: 'edit' },
        // The panel itself uses the token later for custom domains.
        { key: 'dns', type: 'edit' },
        { key: 'user_details', type: 'read' }
    ];

    const permissionParam = JSON.stringify(permissions);
    const url = new URL('https://dash.cloudflare.com/profile/api-tokens');
    url.searchParams.set('permissionGroupKeys', permissionParam);
    url.searchParams.set('accountId', '*');
    url.searchParams.set('zoneId', 'all');
    url.searchParams.set('name', 'ZAGROOO-Wizard');
    document.getElementById('tokenTemplate').href = url.href;
});

togglePass.addEventListener('click', () => {
    const passwordInput = document.getElementById('apiToken');
    const eyeIcon = document.getElementById('eyeIcon');
    const eyeOffIcon = document.getElementById('eyeOffIcon');
    const isPassword = passwordInput.type === 'password';
    passwordInput.type = isPassword ? 'text' : 'password';
    eyeIcon.classList.toggle('hidden', isPassword);
    eyeOffIcon.classList.toggle('hidden', !isPassword);
});

deployForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await startDeploymentPipeline(new FormData(deployForm));
});

async function startDeploymentPipeline(payload) {
    const submitButton = deployForm.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    results.hidden = true;
    results.innerHTML = '';
    out.textContent = '';

    try {
        const response = await fetch('/api/install', {
            method: 'POST',
            body: payload
        });

        if (!response.ok || !response.body) {
            throw new Error(`The wizard returned ${response.status}.`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            let newlineAt;

            while ((newlineAt = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newlineAt).trim();
                buffer = buffer.slice(newlineAt + 1);
                if (!line) continue;

                let event;
                try {
                    event = JSON.parse(line);
                } catch (err) {
                    continue;
                }

                const { type, message } = event;
                if (type === 'complete') {
                    showResults(JSON.parse(message));
                } else {
                    log(type, message);
                }
            }
        }

        log('info', 'Standby...\n');
    } catch (err) {
        log('error', 'Installation failed: ' + (err && err.message ? err.message : err));
    } finally {
        submitButton.disabled = false;
    }
}

function showResults(payload) {
    const list = (payload && payload.results) || [];
    if (!list.length) return;

    const nodes = list.map(item => {
        const state = item.error
            ? `<span class="result-state is-error">failed</span>`
            : `<span class="result-state is-ok">ready</span>`;

        const key = item.apiKey
            ? `<div class="result-key">
                   <code>${item.apiKey}</code>
                   <button type="button" class="copy-key" data-key="${item.apiKey}">Copy API key</button>
               </div>`
            : '';

        const links = [
            item.url ? `<a href="${item.url}" target="_blank" rel="noopener">Panel</a>` : '',
            item.portal ? `<a href="${item.portal}" target="_blank" rel="noopener">Portal</a>` : ''
        ].filter(Boolean).join(' · ');

        return `<div class="result-item">
            <div class="result-head">
                <strong>${item.name}</strong>
                ${state}
                <span class="result-links">${links}</span>
            </div>
            ${key}
            ${item.error ? `<p class="result-error">${item.error}</p>` : ''}
        </div>`;
    });

    results.innerHTML = `
        <h4>Installed panels</h4>
        <p class="results-hint">Copy each API key and add the panel on the
        <a href="/dashboard">dashboard's API page</a>. Keys are shown once.</p>
        ${nodes.join('')}`;
    results.hidden = false;

    results.querySelectorAll('.copy-key').forEach(button => {
        button.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(button.dataset.key);
                button.textContent = 'Copied!';
                setTimeout(() => { button.textContent = 'Copy API key'; }, 1500);
            } catch (error) {
                button.textContent = 'Copy failed';
            }
        });
    });
}

const LABEL_GLYPHS = {
    info: { icon: '•', class: 'terminal-info' },
    error: { icon: '✗', class: 'terminal-error' },
    success: { icon: '✓', class: 'terminal-success' }
};

function log(type, message, url) {
    out.appendChild(elm('br'));

    const label = elm('span', { className: LABEL_GLYPHS[type].class, textContent: LABEL_GLYPHS[type].icon });
    const text = elm('span', { textContent: ` ${message}` });
    out.append(label, text);

    if (url) {
        const link = elm('a', {
            href: url,
            target: '_blank',
            rel: 'noopener',
            className: 'terminal-url',
            textContent: url
        });
        out.appendChild(link);
    }
}

function elm(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...[].concat(children));
    return node;
}
