require('dotenv').config();
const { pool } = require('../db-base');
const fetch = require('node-fetch');

async function testApkLoginFlow() {
  const email = 'thepreethu01@gmail.com';
  const password = 'password123'; // Guessing common dev password, won't log it
  
  console.log(`\n🧪 Testing APK Auth Flow...`);
  
  try {
    // 1. Simulate login (the APK does this via WebView, but let's grab a fresh token)
    console.log(`   1. Generating login JWT...`);
    const res = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
    if (res.rows.length === 0) {
      console.log('   ❌ User not found');
      return;
    }
    const userId = res.rows[0].id;
    
    // Create a dummy token for testing the endpoint
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ id: userId }, process.env.ACCESS_SECRET || process.env.JWT_SECRET || 'secret', { expiresIn: '1h' });
    
    // 2. Simulate the APK's POST request exactly as it's written in Kotlin
    console.log(`   2. Simulating APK POST /update-push-token...`);
    
    const fcmToken = 'test_fcm_token_from_apk_simulation_' + Date.now();
    
    const response = await fetch('https://smarterp-backendend.onrender.com/api/auth/update-push-token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ pushToken: fcmToken })
    });
    
    const text = await response.text();
    console.log(`\n   Response Status: ${response.status}`);
    console.log(`   Response Body: ${text}`);
    
    if (response.status === 200) {
      // Check if it saved!
      const dbCheck = await pool.query(
        `SELECT device_type, last_seen FROM user_devices WHERE fcm_token = $1`, 
        [fcmToken]
      );
      if (dbCheck.rows.length > 0) {
        console.log(`\n✅ DATABASE CONFIRMS IT WORKED!`);
        console.log(`   It arrived as:`, dbCheck.rows[0]);
      } else {
        console.log(`\n⚠️ Request succeeded but token NOT in database. Something is wrong with the SQL logic.`);
      }
    }
  } catch (err) {
    console.error(`❌ Error during test:`, err);
  } finally {
    await pool.end();
  }
}

testApkLoginFlow();
