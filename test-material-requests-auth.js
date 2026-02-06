const fetch = require('node-fetch');

async function testMaterialRequestsWithAuth() {
    const BACKEND_URL = 'https://smarterp-backendend.onrender.com';

    console.log('🧪 Testing Material Requests with Authentication\n');

    // Step 1: Login to get auth token
    console.log('1️⃣ Logging in...');
    try {
        const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: 'mrpreethu714@gmail.com',
                password: 'your_password_here' // You'll need to provide the actual password
            })
        });

        if (!loginRes.ok) {
            console.log('❌ Login failed:', loginRes.status);
            const error = await loginRes.text();
            console.log('Error:', error);
            return;
        }

        const loginData = await loginRes.json();
        const token = loginData.accessToken;
        console.log('✅ Login successful');
        console.log('User:', loginData.user);

        // Step 2: Try to GET material requests
        console.log('\n2️⃣ Fetching material requests...');
        const getRes = await fetch(`${BACKEND_URL}/api/material-requests`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        console.log('Status:', getRes.status);

        if (!getRes.ok) {
            const errorText = await getRes.text();
            console.log('❌ GET Error Response:', errorText);

            // Try to parse as JSON
            try {
                const errorJson = JSON.parse(errorText);
                console.log('Error JSON:', JSON.stringify(errorJson, null, 2));
            } catch (e) {
                console.log('Error is not JSON');
            }
        } else {
            const data = await getRes.json();
            console.log('✅ Successfully fetched requests:', data.length);
        }

        // Step 3: Try to POST a material request
        console.log('\n3️⃣ Creating a test material request...');
        const postRes = await fetch(`${BACKEND_URL}/api/material-requests`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                item_name: 'Test Item',
                quantity: 10,
                urgency: 'Medium',
                description: 'Test description'
            })
        });

        console.log('Status:', postRes.status);

        if (!postRes.ok) {
            const errorText = await postRes.text();
            console.log('❌ POST Error Response:', errorText);

            // Try to parse as JSON
            try {
                const errorJson = JSON.parse(errorText);
                console.log('Error JSON:', JSON.stringify(errorJson, null, 2));
            } catch (e) {
                console.log('Error is not JSON');
            }
        } else {
            const data = await postRes.json();
            console.log('✅ Successfully created request:', data);
        }

    } catch (err) {
        console.error('❌ Test failed:', err.message);
    }
}

testMaterialRequestsWithAuth();
