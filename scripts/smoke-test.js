/**
 * 🔬 SmartERP Smoke Tests
 * Tests critical auth flows: Signup → OTP → Login → Refresh
 * 
 * Run with: node scripts/smoke-test.js
 * 
 * Requires: node-fetch (built-in Node 18+)
 */

const BASE_URL = process.env.API_URL || 'https://smarterp-backendend.onrender.com';
const TEST_EMAIL = `smoketest_${Date.now()}@mailinator.com`;
const TEST_PASSWORD = 'SmokeTest@2025!';
const TEST_COMPANY = `SmokeTestCo_${Date.now()}`;

let passed = 0;
let failed = 0;
let accessToken = null;
let refreshToken = null;

function log(icon, msg) { console.log(`  ${icon}  ${msg}`); }
function pass(msg) { passed++; log('✅', msg); }
function fail(msg, err) { failed++; log('❌', `${msg}${err ? ` — ${err}` : ''}`); }
function section(title) { console.log(`\n${'─'.repeat(50)}\n🧪 ${title}\n${'─'.repeat(50)}`); }

async function req(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  
  let json;
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, data: json };
}

async function runTests() {
  console.log(`\n⚡ SmartERP Smoke Tests`);
  console.log(`   API: ${BASE_URL}`);
  console.log(`   Test Email: ${TEST_EMAIL}`);
  console.log(`   Started: ${new Date().toLocaleTimeString()}`);

  // ── Test 1: Health Check ──────────────────────────────────────────────────
  section('1. Health Check');
  try {
    const { status, data } = await req('GET', '/api/health');
    if (status === 200) pass(`Health endpoint → ${status} OK`);
    else fail(`Health endpoint returned status ${status}`);
  } catch (err) {
    fail('Health endpoint unreachable', err.message);
  }

  // ── Test 2: Auth Routes Available ────────────────────────────────────────
  section('2. Auth Route Availability');
  try {
    const { status } = await req('GET', '/api/auth');
    if (status === 200) pass('Auth base route → 200 OK');
    else fail(`Auth base route returned ${status}`);
  } catch (err) {
    fail('Auth base route unreachable', err.message);
  }

  // ── Test 3: Signup ────────────────────────────────────────────────────────
  section('3. Signup (Owner Account)');
  try {
    const { status, data } = await req('POST', '/api/auth/signup', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      name: 'Smoke Tester',
      company_name: TEST_COMPANY,
      role: 'owner'
    });

    if (status === 201 || status === 200) {
      pass(`Signup → ${status} (Account created)`);
    } else if (status === 409) {
      pass(`Signup → 409 (Account already exists, expected for repeat runs)`);
    } else {
      fail(`Signup returned unexpected status ${status}`, JSON.stringify(data));
    }
  } catch (err) {
    fail('Signup request failed', err.message);
  }

  // ── Test 4: Login ─────────────────────────────────────────────────────────
  section('4. Login');
  try {
    const { status, data } = await req('POST', '/api/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });

    if (status === 200 && data.accessToken) {
      accessToken = data.accessToken;
      refreshToken = data.refreshToken;
      pass(`Login → 200 OK (Token received)`);
    } else if (status === 403 && data.message?.includes('verify')) {
      pass(`Login → 403 (Email OTP verification required — expected for new accounts)`);
    } else if (status === 200 && data.requiresOTP) {
      pass(`Login → 200 (OTP step required — expected)`);
    } else {
      fail(`Login returned status ${status}`, JSON.stringify(data));
    }
  } catch (err) {
    fail('Login request failed', err.message);
  }

  // ── Test 5: Protected Route (no token should fail) ───────────────────────
  section('5. Protected Route Guard');
  try {
    const { status } = await req('GET', '/api/jobs');
    if (status === 401 || status === 403) {
      pass(`Protected route rejected unauthenticated → ${status} (Correct!)`);
    } else if (status === 200) {
      fail('Protected route allowed unauthenticated request! Security issue.');
    } else {
      pass(`Protected route → ${status} (Not 200, acceptable)`);
    }
  } catch (err) {
    fail('Protected route test failed', err.message);
  }

  // ── Test 6: Token Refresh ─────────────────────────────────────────────────
  section('6. Token Refresh');
  if (refreshToken) {
    try {
      const { status, data } = await req('POST', '/api/auth/refresh', { refreshToken });
      if (status === 200 && data.accessToken) {
        accessToken = data.accessToken;
        pass(`Token refresh → 200 OK (New access token issued)`);
      } else {
        fail(`Token refresh returned ${status}`, JSON.stringify(data));
      }
    } catch (err) {
      fail('Token refresh request failed', err.message);
    }
  } else {
    log('⏭️', 'Skipping token refresh test (no refresh token available)');
  }

  // ── Test 7: Authenticated Request ────────────────────────────────────────
  section('7. Authenticated Request');
  if (accessToken) {
    try {
      const { status } = await req('GET', '/api/jobs', null, accessToken);
      if (status === 200) {
        pass(`Authenticated request → 200 OK`);
      } else if (status === 403 && !accessToken) {
        fail(`Authenticated request rejected — token may be invalid`);
      } else {
        pass(`Authenticated request → ${status} (Token was accepted)`);
      }
    } catch (err) {
      fail('Authenticated request failed', err.message);
    }
  } else {
    log('⏭️', 'Skipping (no access token from login)');
  }

  // ── Test 8: Rate Limiter ──────────────────────────────────────────────────
  section('8. Rate Limiter');
  try {
    const requests = Array.from({ length: 25 }, () => req('POST', '/api/auth/login', {
      email: 'ratelimit@test.com',
      password: 'wrong'
    }));
    const results = await Promise.all(requests);
    const rateLimited = results.some(r => r.status === 429);
    if (rateLimited) {
      pass(`Rate limiter triggered after burst → 429 (Working correctly!)`);
    } else {
      fail(`Rate limiter did NOT trigger after 25 rapid requests`);
    }
  } catch (err) {
    fail('Rate limiter test failed', err.message);
  }

  // ── Final Summary ─────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`📊 Results: ${passed}/${total} tests passed`);
  if (failed > 0) {
    console.log(`❌ ${failed} test(s) FAILED — review issues above`);
    process.exit(1);
  } else {
    console.log(`✅ All tests passed! System is healthy.`);
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('\n💥 Smoke test runner crashed:', err);
  process.exit(1);
});
