const fetch = require('node-fetch');

async function checkDeployment() {
    const BACKEND_URL = 'https://smarterp-backendend.onrender.com';

    console.log('🔍 Checking Render deployment status...\n');

    try {
        const res = await fetch(`${BACKEND_URL}/api/health`);
        const health = await res.json();
        console.log('✅ Backend Health:', health);
        console.log('\n📅 Server Time:', health.time);
        console.log('🗄️  Database:', health.database);

        // Check if the server was recently restarted (within last 10 minutes)
        const serverTime = new Date(health.time);
        const now = new Date();
        const diffMinutes = (now - serverTime) / 1000 / 60;

        console.log(`\n⏱️  Time difference: ${diffMinutes.toFixed(2)} minutes`);

        if (diffMinutes < 10) {
            console.log('✅ Server was recently restarted - likely deployed new code');
        } else {
            console.log('⚠️  Server has been running for a while - may still be on old code');
            console.log('   Wait 2-3 more minutes for Render to deploy');
        }

    } catch (err) {
        console.log('❌ Error:', err.message);
    }
}

checkDeployment();
