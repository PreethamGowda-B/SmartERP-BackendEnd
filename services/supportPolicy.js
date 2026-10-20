'use strict';

const { SUBSCRIPTION_PLANS } = require('./subscriptionCatalog');

const BUSINESS_TIME_ZONE = 'Asia/Kolkata';
const BUSINESS_START_MINUTE = 9 * 60;
const BUSINESS_END_MINUTE = 18 * 60;
const INDIA_OFFSET_MS = 330 * 60 * 1000;

function getSupportPolicy(planId) {
  return SUBSCRIPTION_PLANS[Number(planId)]?.supportPolicy || null;
}

function isSupportChannelAllowed(policy, channel) {
  return Boolean(policy && Array.isArray(policy.channels) && policy.channels.includes(channel));
}

function calculateFirstResponseDueAt(startAt, businessHours) {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    throw new TypeError('A valid start date is required.');
  }
  if (!Number.isFinite(businessHours) || businessHours <= 0) {
    throw new RangeError('Business-hour response target must be positive.');
  }

  const local = new Date(startAt.getTime() + INDIA_OFFSET_MS);
  const hasSubMinuteRemainder = local.getUTCSeconds() !== 0 || local.getUTCMilliseconds() !== 0;
  local.setUTCSeconds(0, 0);
  if (hasSubMinuteRemainder) local.setTime(local.getTime() + 60 * 1000);
  let remainingMinutes = Math.ceil(businessHours * 60);

  while (remainingMinutes > 0) {
    const day = local.getUTCDay();
    if (day === 0 || day === 6) {
      local.setUTCDate(local.getUTCDate() + (day === 6 ? 2 : 1));
      local.setUTCHours(9, 0, 0, 0);
      continue;
    }

    const minuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minuteOfDay < BUSINESS_START_MINUTE) {
      local.setUTCHours(9, 0, 0, 0);
      continue;
    }
    if (minuteOfDay >= BUSINESS_END_MINUTE) {
      local.setUTCDate(local.getUTCDate() + 1);
      local.setUTCHours(9, 0, 0, 0);
      continue;
    }

    const availableMinutes = BUSINESS_END_MINUTE - minuteOfDay;
    const consumedMinutes = Math.min(remainingMinutes, availableMinutes);
    local.setTime(local.getTime() + consumedMinutes * 60 * 1000);
    remainingMinutes -= consumedMinutes;
  }

  return new Date(local.getTime() - INDIA_OFFSET_MS);
}

function formatResponseTarget(policy) {
  const hours = Number(policy?.firstResponseBusinessHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (hours % 9 === 0) {
    const days = hours / 9;
    return `within ${days} business day${days === 1 ? '' : 's'}`;
  }
  return `within ${hours} business hour${hours === 1 ? '' : 's'}`;
}

module.exports = {
  BUSINESS_TIME_ZONE,
  getSupportPolicy,
  isSupportChannelAllowed,
  calculateFirstResponseDueAt,
  formatResponseTarget,
};
