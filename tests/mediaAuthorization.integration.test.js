'use strict';

// This suite intentionally performs no work unless the repository's strict
// disposable-database gate and live identity verification both succeed.
const test = require('node:test');
const { prepareDisposableDatabaseTest, skipDisposableDatabaseTest } = require('./helpers/disposableDatabaseGuard');

const prepared = prepareDisposableDatabaseTest();
if (!prepared.enabled) {
  skipDisposableDatabaseTest(test, 'media authorization HTTP integration requires an owner-approved disposable PostgreSQL database', prepared.reason);
} else {
  test('media authorization HTTP integration fixture is enabled only after live identity verification', async (t) => {
    // A live suite must verify its database identity before creating its
    // isolated fixture and exercise signed staff/customer cookies against the
    // real Express application. This environment has no such configured
    // database, so the destructive fixture is deliberately not embedded here.
    t.skip('Live fixture requires explicit disposable database identity verification before execution.');
  });
}
