const fs = require('fs');
const path = require('path');

const count = 50000; // Large enough for the test
const csvPath = path.join(__dirname, 'users.csv');
const stream = fs.createWriteStream(csvPath);

console.log(`Generating ${count} test users...`);
stream.write('name,email,password\n');

for (let i = 0; i < count; i++) {
  const name = `TestUser${i}`;
  const email = `user${i}@test.com`;
  const password = `password123`;
  stream.write(`${name},${email},${password}\n`);
}

stream.end();
console.log(`Done! Saved to ${csvPath}`);
