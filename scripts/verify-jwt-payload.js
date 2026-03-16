const jwt = require('jsonwebtoken');
require('dotenv').config();

const ACCESS_SECRET = process.env.JWT_SECRET;

function verifyPayload() {
  console.log('--- JWT Payload Verification ---');
  
  if (!ACCESS_SECRET) {
    console.error('❌ JWT_SECRET is not defined in .env');
    process.exit(1);
  }

  const testUser = {
    id: 'test-uuid',
    userId: 'test-uuid',
    role: 'owner',
    email: 'prozyncinnovations@gmail.com',
    companyId: 123
  };

  const token = jwt.sign(testUser, ACCESS_SECRET, { expiresIn: '15m' });
  console.log('✅ Generated test token');

  try {
    const decoded = jwt.verify(token, ACCESS_SECRET);
    console.log('📦 Decoded Payload:', JSON.stringify(decoded, null, 2));

    const requiredFields = ['id', 'userId', 'role', 'email', 'companyId'];
    let allPresent = true;

    for (const field of requiredFields) {
      if (decoded[field] === undefined) {
        console.error(`❌ Field "${field}" is missing!`);
        allPresent = false;
      } else {
        console.log(`✅ Field "${field}" is present: ${decoded[field]}`);
      }
    }

    if (allPresent) {
      console.log('🚀 Verification PASSED: JWT payload contains all required fields.');
    } else {
      console.log('⛔ Verification FAILED: Some fields are missing.');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ JWT Verification failed:', err.message);
    process.exit(1);
  }
}

verifyPayload();
