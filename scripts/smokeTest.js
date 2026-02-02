const fetch = require('node-fetch');

const base = process.env.API_BASE || 'http://localhost:4000';

function extractCookie(headers) {
  console.log('Headers:', headers.raw ? headers.raw() : headers);
  if (!headers.raw) return null;
  const raw = headers.raw()['set-cookie'];
  if (!raw) return null;
  return raw.map(s => s.split(';')[0]).join('; ');
}

async function run() {
  console.log('Running smoke tests against', base);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'admin@example.com', password: 'admin123' }), headers: { 'Content-Type': 'application/json' } });
  if (!login.ok) throw new Error('Login failed: ' + login.status);
  const body = await login.json();
  console.log('Login OK, user:', body.user.email);

  const cookie = extractCookie(login);
  if (!cookie) throw new Error('No cookies set by login');

  const me = await fetch(base + '/api/users/me', { headers: { Cookie: cookie } });
  if (!me.ok) throw new Error('/api/users/me failed: ' + me.status);
  console.log('/api/users/me OK');

  console.log('Smoke tests passed');
}

run().catch(err => { console.error(err); process.exit(1); });
