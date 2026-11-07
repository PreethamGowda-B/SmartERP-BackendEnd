const test = require('node:test');
const assert = require('node:assert/strict');
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = 'postgresql://app:pw@localhost:5432/smarterp_test';
const { resolvePoolMax, DEFAULT_DB_POOL_MAX, cleanConnectionString } = require('../db-base');
if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = originalDatabaseUrl;

test('database pool defaults to two clients per process for the session-pool budget', () => {
  assert.equal(DEFAULT_DB_POOL_MAX, 2);
  assert.equal(resolvePoolMax(undefined), 2);
  assert.equal(resolvePoolMax(''), 2);
});

test('database pool accepts a valid explicit pool limit', () => {
  assert.equal(resolvePoolMax('3'), 3);
  assert.equal(resolvePoolMax('8'), 8);
});

test('database pool falls back safely for invalid or non-positive limits', () => {
  assert.equal(resolvePoolMax('not-a-number'), 2);
  assert.equal(resolvePoolMax('0'), 2);
  assert.equal(resolvePoolMax('-2'), 2);
});

test('Supabase URLs are preserved exactly when session-compatible', () => {
  const direct = 'postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=require';
  const sharedSession = 'postgresql://smarterp_test.abcdefghijklmnopqrst:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
  assert.equal(cleanConnectionString(direct), direct);
  assert.equal(cleanConnectionString(sharedSession), sharedSession);
});

test('Supabase shared transaction URLs are upgraded to the shared session port without changing credentials', () => {
  const transaction = 'postgresql://role.abcdefghijklmnopqrst:secret@aws-0-us-east-1.pooler.supabase.com:6543/postgres?sslmode=require';
  assert.equal(
    cleanConnectionString(transaction),
    'postgresql://role.abcdefghijklmnopqrst:secret@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require'
  );
  const dedicatedTransaction = 'postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:6543/postgres';
  assert.equal(cleanConnectionString(dedicatedTransaction), dedicatedTransaction);
  assert.throws(() => cleanConnectionString('postgresql://postgres:secret@db.abcdefghijklmnopqrst.supabase.co:5432/postgres?sslmode=disable'), /must use SSL/);
});
