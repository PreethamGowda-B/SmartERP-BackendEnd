'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canViewAutoSchedule, buildWorkloadRankings } = require('../routes/autoSchedule');

test('auto-schedule restricts company workload rankings to operations roles', () => {
  for (const role of ['owner', 'admin', 'hr', 'service_manager']) assert.equal(canViewAutoSchedule(role), true);
  for (const role of ['employee', 'customer', 'super_admin', undefined]) assert.equal(canViewAutoSchedule(role), false);
});

test('auto-schedule ranking reports only recorded workload evidence', () => {
  const [row] = buildWorkloadRankings([{ id: 'u1', name: 'Engineer', position: null, active_job_count: 2 }]);
  assert.equal(row.active_jobs, 2);
  assert.match(row.recommendation_reason, /No skill, certification, or machine compatibility data was used/);
  assert.equal('controller_expertise' in row, false);
  assert.equal('match_score' in row, false);
});
