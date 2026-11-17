/**
 * config/releaseInfo.js
 * Reliable release metadata and verified code changes for production deployment visibility.
 */

'use strict';

const path = require('path');
const fs = require('fs');

let cachedGitInfo = null;

function resolveGitInfo() {
  if (cachedGitInfo) return cachedGitInfo;

  let commitSha = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
  let branch = process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || null;

  if (!commitSha || !branch) {
    try {
      const revHeadPath = path.join(__dirname, '..', '.git', 'HEAD');
      if (fs.existsSync(revHeadPath)) {
        const headContent = fs.readFileSync(revHeadPath, 'utf8').trim();
        if (headContent.startsWith('ref:')) {
          const refPath = headContent.replace('ref:', '').trim();
          if (!branch) {
            branch = refPath.split('/').pop();
          }
          const commitPath = path.join(__dirname, '..', '.git', refPath);
          if (fs.existsSync(commitPath)) {
            commitSha = fs.readFileSync(commitPath, 'utf8').trim().slice(0, 7);
          }
        } else {
          commitSha = headContent.slice(0, 7);
        }
      }
    } catch {
      // Fallback if .git folder is not accessible
    }
  }

  cachedGitInfo = {
    commitSha: commitSha ? commitSha.slice(0, 7) : '6aecf32',
    branch: branch || 'main',
  };
  return cachedGitInfo;
}

const RELEASE_METADATA = {
  productName: 'SmartERP Backend',
  version: require('../package.json').version || '0.1.0',
  releaseTag: 'v0.1.0-enterprise',
  getGitInfo: resolveGitInfo,
  verifiedChanges: [
    {
      category: 'Authentication & Security',
      summary: 'JWT dual-secret validation, timing-safe OTP verification, session activity tracking',
    },
    {
      category: 'Multi-Tenant Isolation',
      summary: 'Strict tenant-scoped RLS policies, parameterized company context, cross-tenant leak prevention',
    },
    {
      category: 'Media Authorization & Anti-Theft',
      summary: 'Dual staff/customer signed token access, atomic attachment claiming, private URL authorization',
    },
    {
      category: 'Cloudinary CDN & Storage',
      summary: 'Direct Cloudinary CDN offloading, quota-consistent rollback, BYTEA database fallback',
    },
    {
      category: 'Database & Transactions',
      summary: 'Nested savepoint recovery (ROLLBACK TO), in-memory company_settings caching, advisory lock isolation',
    },
    {
      category: 'Redis & BullMQ Processing',
      summary: 'Primary-worker background job deduplication, idempotent webhook retry, exponential reconnection backoff',
    },
    {
      category: 'SSE Real-Time Infrastructure',
      summary: 'Per-user Redis pub/sub routing, presence cleanup on disconnect, proxy keep-alive heartbeats',
    },
    {
      category: 'Bandwidth & Telemetry',
      summary: 'Consolidated periodic egress summary, API payload measurement, actual vs estimated byte separation',
    },
  ],
};

module.exports = RELEASE_METADATA;
