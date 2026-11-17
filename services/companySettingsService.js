/**
 * services/companySettingsService.js
 * High-performance, multi-tenant in-memory cached access for company_settings.
 * Eliminates repeated slow queries to company_settings across API requests.
 * Features 60-second TTL and multi-worker cross-process invalidation.
 */

'use strict';

const logger = require('../utils/logger');

const SETTINGS_CACHE_TTL_MS = 60_000; // 60s in-memory TTL
const settingsCache = new Map();
const CACHE_INVALIDATION_CHANNEL = 'smarterp:cache:invalidation';
let subscriberInitialized = false;

/**
 * Normalizes companyId to a trimmed string key
 */
function cacheKeyFor(companyId) {
  if (!companyId) return null;
  return String(companyId).trim();
}

/**
 * Initialize cross-worker Redis pub/sub listener (lazy, non-blocking)
 */
function initCrossWorkerSync() {
  if (subscriberInitialized) return;
  try {
    const { getSharedSubscriber } = require('../utils/redis');
    const subscriber = getSharedSubscriber();
    if (!subscriber) return;

    subscriber.subscribe(CACHE_INVALIDATION_CHANNEL, (err) => {
      if (!err) {
        subscriberInitialized = true;
      }
    });

    subscriber.on('message', (channel, message) => {
      if (channel === CACHE_INVALIDATION_CHANNEL) {
        try {
          const payload = JSON.parse(message);
          if (payload?.type === 'company_settings' && payload.companyId) {
            const key = cacheKeyFor(payload.companyId);
            if (key && settingsCache.has(key)) {
              settingsCache.delete(key);
              logger.debug(`[companySettingsService] Remote Redis cache invalidation for company ${key}`);
            }
          }
        } catch (_) {}
      }
    });
    subscriberInitialized = true;
  } catch (_) {
    // Non-fatal if Redis pub/sub is unavailable; 60s TTL guarantees eventual consistency
  }
}

/**
 * Invalidate cached settings for a company (called after PUT/POST updates)
 * @param {string|number} companyId
 * @param {boolean} [fromRemote=false] - Whether this call was triggered by remote IPC/PubSub
 */
function invalidateCompanySettings(companyId, fromRemote = false) {
  const key = cacheKeyFor(companyId);
  if (!key) return;

  if (settingsCache.has(key)) {
    settingsCache.delete(key);
    logger.debug(`[companySettingsService] Invalidated cache for company ${key}`);
  }

  if (fromRemote) return;

  // 1. Cross-worker sync via Redis pub/sub (across dynos/containers)
  try {
    const { redisClient } = require('../utils/redis');
    if (redisClient && redisClient.status === 'ready') {
      redisClient.publish(
        CACHE_INVALIDATION_CHANNEL,
        JSON.stringify({ type: 'company_settings', companyId: key })
      ).catch(() => {});
    }
  } catch (_) {}

  // 2. Cross-worker sync via Cluster IPC (between workers on same host)
  if (process.send && typeof process.send === 'function') {
    try {
      process.send({ cmd: 'cache:invalidate:company_settings', companyId: key });
    } catch (_) {}
  }
}

/**
 * Fetch settings map for a company with in-memory caching
 * @param {string|number} companyId
 * @param {string[]} settingKeys
 * @param {object} pool - PostgreSQL pool or queryable client
 * @returns {Promise<Record<string, string>>}
 */
async function getCompanySettings(companyId, settingKeys = [], pool) {
  const key = cacheKeyFor(companyId);
  if (!key) return {};

  initCrossWorkerSync();

  const now = Date.now();
  const cached = settingsCache.get(key);

  // Check if all requested keys are satisfied by active cache entry
  if (cached && cached.expiresAt > now) {
    if (!settingKeys.length) {
      return { ...cached.data };
    }
    const allPresent = settingKeys.every(k => Object.prototype.hasOwnProperty.call(cached.data, k));
    if (allPresent) {
      const result = {};
      for (const k of settingKeys) {
        result[k] = cached.data[k];
      }
      return result;
    }
  }

  // Cache miss or partial miss — query database
  try {
    let query;
    let params;

    if (settingKeys.length > 0) {
      query = `SELECT setting_key, setting_value FROM company_settings WHERE company_id = $1 AND setting_key = ANY($2::text[])`;
      params = [key, settingKeys];
    } else {
      query = `SELECT setting_key, setting_value FROM company_settings WHERE company_id = $1`;
      params = [key];
    }

    const { pool: defaultPool } = require('../db');
    const queryable = pool || defaultPool;
    const res = await queryable.query(query, params);

    const mergedData = cached && cached.expiresAt > now ? { ...cached.data } : {};
    for (const row of res.rows) {
      mergedData[row.setting_key] = row.setting_value;
    }

    // Set missing requested keys to null so we don't re-query missing keys repeatedly
    for (const k of settingKeys) {
      if (!Object.prototype.hasOwnProperty.call(mergedData, k)) {
        mergedData[k] = null;
      }
    }

    settingsCache.set(key, {
      data: mergedData,
      expiresAt: now + SETTINGS_CACHE_TTL_MS,
    });

    const output = {};
    const targetKeys = settingKeys.length ? settingKeys : Object.keys(mergedData);
    for (const k of targetKeys) {
      output[k] = mergedData[k];
    }
    return output;
  } catch (err) {
    logger.warn(`[companySettingsService] Failed to query company_settings for ${key}: ${err.message}`);
    return cached ? { ...cached.data } : {};
  }
}

/**
 * Fetch a single setting value
 */
async function getCompanySetting(companyId, settingKey, defaultValue = null, pool) {
  const settings = await getCompanySettings(companyId, [settingKey], pool);
  return settings[settingKey] !== undefined && settings[settingKey] !== null
    ? settings[settingKey]
    : defaultValue;
}

module.exports = {
  getCompanySettings,
  getCompanySetting,
  invalidateCompanySettings,
  _cache: settingsCache,
  SETTINGS_CACHE_TTL_MS,
};
