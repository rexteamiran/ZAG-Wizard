/* ZAGROOO Wizard — sign in / create account. */

const $ = id => document.getElementById(id);

let mode = 'login';

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        mode = tab.dataset.tab;

        document.querySelectorAll('.tab').forEach(node => node.classList.toggle('is-active', node === tab));
        $('login-form').hidden = mode !== 'login';
        $('register-form').hidden = mode !== 'register';
        $('error').hidden = true;
    });
});

async function submit(url, payload, form) {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await res.json();
        if (!data.success) {
            $('error').textContent = data.message || 'Something went wrong.';
            $('error').hidden = false;
            return;
        }

        location.href = '/dashboard';
    } catch (error) {
        $('error').textContent = error.message || 'Network error.';
        $('error').hidden = false;
    } finally {
        button.disabled = false;
    }
}

$('login-form').addEventListener('submit', event => {
    event.preventDefault();
    submit('/api/auth/login', {
        email: $('login-email').value.trim(),
        password: $('login-password').value
    }, event.target);
});

$('register-form').addEventListener('submit', event => {
    event.preventDefault();
    submit('/api/auth/register', {
        email: $('reg-email').value.trim(),
        password: $('reg-password').value,
        invite: $('reg-invite').value
    }, event.target);
});
