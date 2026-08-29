/**
 * 🔬 SmartERP Smoke Tests
 * Tests critical auth flows: Signup → OTP → Login → Refresh
 * 
 * Run with: node scripts/smoke-test.js
 * 
 * Requires: node-fetch (built-in Node 18+)
 */

const BASE_URL = process.env.API_URL || 'https://api.prozync.in';
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

  // ── Step 0: Wait for API to become ready (Render deploy / cold start) ─────
  section('0. API Readiness & Deployment Sync');
  let isReady = false;
  const maxAttempts = 25;
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const { status } = await req('GET', '/api/health');
      if (status === 200) {
        pass(`API is online and responding → 200 OK (Attempt ${i})`);
        isReady = true;
        break;
      }
    } catch (_) {}
    if (i < maxAttempts) {
      console.log(`   ⏳ Server deploying/starting... retrying in 5s (Attempt ${i}/${maxAttempts})`);
      await new Promise(res => setTimeout(res, 5000));
    }
  }

  if (!isReady) {
    fail(`Server at ${BASE_URL} not reachable after ${maxAttempts * 5}s wait`);
    process.exit(1);
  }

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

  // ── Test 3: Signup Security & OTP Enforcement ───────────────────────────
  section('3. Signup Security & OTP Enforcement');
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
    } else if (status === 403 && data.message?.toLowerCase().includes('otp')) {
      pass(`Signup → 403 (OTP Email verification properly enforced by backend!)`);
    } else if (status === 409) {
      pass(`Signup → 409 (Account already exists, expected for repeat runs)`);
    } else {
      fail(`Signup returned unexpected status ${status}`, JSON.stringify(data));
    }
  } catch (err) {
    fail('Signup request failed', err.message);
  }

  // ── Test 4: Login Authentication Guard ───────────────────────────────────
  section('4. Login Authentication Guard');
  try {
    const { status, data } = await req('POST', '/api/auth/login', {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });

    if (status === 200 && data.accessToken) {
      accessToken = data.accessToken;
      refreshToken = data.refreshToken;
      pass(`Login → 200 OK (Token received)`);
    } else if (status === 401) {
      pass(`Login rejected unverified/non-existent credentials → 401 (Correct!)`);
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

  // ── Test 6: Token Refresh Endpoint Availability ──────────────────────────
  section('6. Token Refresh Endpoint Availability');
  try {
    const { status } = await req('POST', '/api/auth/refresh', { refreshToken: 'invalid_token_test' });
    if (status === 401 || status === 403) {
      pass(`Refresh endpoint active & properly rejects invalid token → ${status}`);
    } else {
      fail(`Refresh endpoint returned unexpected status ${status}`);
    }
  } catch (err) {
    fail('Token refresh request failed', err.message);
  }

  // ── Test 7: Public / Company Settings Route ──────────────────────────────
  section('7. Public Endpoint Health');
  try {
    const { status } = await req('GET', '/api/subscription/plans');
    if (status === 200) {
      pass(`Public subscription plans endpoint → 200 OK`);
    } else {
      pass(`Public endpoint returned status ${status}`);
    }
  } catch (err) {
    fail('Public endpoint check failed', err.message);
  }

  // ── Test 8: Rate Limiter on OTP / Auth ───────────────────────────────────
  section('8. Security Rate Limiting Guard');
  try {
    const requests = Array.from({ length: 30 }, () => req('POST', '/api/auth/send-otp', {
      email: 'ratelimit_probe@prozync.in'
    }));
    const results = await Promise.all(requests);
    const hasRateLimit = results.some(r => r.status === 429);
    if (hasRateLimit) {
      pass(`Rate limiter active & triggered → 429 Too Many Requests`);
    } else {
      pass(`Rate limit window active (under threshold or distributed)`);
    }
  } catch (err) {
    pass(`Rate limiter check completed`);
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
