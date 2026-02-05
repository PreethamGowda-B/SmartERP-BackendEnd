const fetch = require('node-fetch');

async function testMaterialRequests() {
    const BACKEND_URL = 'https://smarterp-backendend.onrender.com';

    console.log('🧪 Testing Material Requests API...\n');

    // Test 1: Health check
    console.log('1️⃣ Testing backend health...');
    try {
        const healthRes = await fetch(`${BACKEND_URL}/api/health`);
        const health = await healthRes.json();
        console.log('✅ Backend is healthy:', health);
    } catch (err) {
        console.log('❌ Backend health check failed:', err.message);
    }

    // Test 2: Check if material-requests endpoint exists
    console.log('\n2️⃣ Testing material-requests endpoint (without auth)...');
    try {
        const res = await fetch(`${BACKEND_URL}/api/material-requests`);
        console.log('Status:', res.status);

        if (res.status === 401) {
            console.log('✅ Endpoint exists (401 = needs authentication)');
        } else if (res.status === 500) {
            const error = await res.text();
            console.log('❌ 500 Error response:', error);
        } else {
            const data = await res.text();
            console.log('Response:', data);
        }
    } catch (err) {
        console.log('❌ Request failed:', err.message);
    }

    console.log('\n📋 Test complete');
}

testMaterialRequests();
