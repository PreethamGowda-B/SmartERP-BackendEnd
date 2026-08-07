const EventEmitter = require('events');
const { pool } = require('../db');
const redisClient = require('../utils/redis');

class SmartERPEventBus extends EventEmitter {}

const eventBus = new SmartERPEventBus();

/**
 * Emit an event across system modules and log to activities audit trail.
 */
async function emitSystemEvent(eventName, payload = {}) {
  const { companyId = 1, userId = null, action, details = {}, ip = '127.0.0.1' } = payload;

  console.log(`⚡ [EVENT BUS] Event Triggered: ${eventName} (Company: ${companyId})`);

  // 1. Emit local event listener
  eventBus.emit(eventName, payload);

  // 2. Broadcast via Redis Pub/Sub for multi-instance / SSE push
  if (redisClient && redisClient.status === 'ready') {
    try {
      await redisClient.publish('smarterp_events', JSON.stringify({ eventName, payload }));
    } catch (e) {
      console.warn('⚠️ Redis event publish failed:', e.message);
    }
  }

  // 3. Log event into immutable audit trail (`activities` table)
  try {
    await pool.query(
      `INSERT INTO activities (user_id, action, details, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [
        userId || '00000000-0000-0000-0000-000000000000',
        action || eventName,
        JSON.stringify({ eventName, companyId, ip, ...details }),
      ]
    );
  } catch (err) {
    console.error('❌ Failed to record event in activities audit log:', err.message);
  }
}

module.exports = { eventBus, emitSystemEvent };
