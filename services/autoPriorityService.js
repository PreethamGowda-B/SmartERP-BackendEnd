/**
 * services/autoPriorityService.js
 *
 * Auto Priority Service (formerly aiPriorityService)
 *
 * Section 10: Renamed from "AI" to "auto_priority" to accurately reflect
 * the current keyword-based implementation. The interface is designed to
 * support a future ML/historical-data upgrade without changing callers.
 *
 * Current implementation: keyword-based scoring
 * Future upgrade path:
 *   - Replace suggestPriority() body with ML model call
 *   - Add historical data lookup (customer importance, past job patterns)
 *   - Interface (inputs/outputs) remains identical
 *
 * Returns: 'high' | 'medium' | 'low'
 * Always non-blocking — if this service fails, the job proceeds with user-provided priority.
 */

'use strict';

// ─── Keyword maps ─────────────────────────────────────────────────────────────
const HIGH_PRIORITY_KEYWORDS = [
  'emergency', 'urgent', 'critical', 'broken', 'leak', 'leaking', 'fire',
  'flood', 'flooding', 'burst', 'danger', 'dangerous', 'hazard', 'hazardous',
  'immediate', 'asap', 'now', 'today', 'outage', 'down', 'not working',
  'stopped working', 'failure', 'failed', 'crash', 'crashed', 'severe',
  'serious', 'major', 'accident', 'injury', 'safety', 'gas', 'electric shock',
  'power outage', 'no power', 'no water', 'sewage', 'overflow',
];

const LOW_PRIORITY_KEYWORDS = [
  'maintenance', 'inspection', 'scheduled', 'routine', 'regular', 'annual',
  'monthly', 'weekly', 'check', 'checkup', 'service', 'servicing', 'cleaning',
  'clean', 'minor', 'small', 'cosmetic', 'paint', 'painting', 'touch up',
  'when available', 'no rush', 'low priority', 'whenever', 'future',
  'planning', 'upgrade', 'improvement', 'enhancement',
];

// ─── Core suggestion logic ────────────────────────────────────────────────────
/**
 * Analyze job title + description and return a suggested priority.
 * This function is synchronous and pure — easy to unit test and replace.
 *
 * Future ML upgrade: replace this function body with a model call.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {{ priority: 'high'|'medium'|'low', confidence: number, matched_keywords: string[], method: string }}
 */
function suggestPriority(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();

  const highMatches = HIGH_PRIORITY_KEYWORDS.filter((kw) => text.includes(kw));
  const lowMatches  = LOW_PRIORITY_KEYWORDS.filter((kw) => text.includes(kw));

  if (highMatches.length > 0) {
    return {
      priority: 'high',
      confidence: Math.min(1.0, highMatches.length * 0.3),
      matched_keywords: highMatches,
      method: 'keyword', // Future: 'ml_model' | 'historical'
    };
  }

  if (lowMatches.length > 0) {
    return {
      priority: 'low',
      confidence: Math.min(1.0, lowMatches.length * 0.3),
      matched_keywords: lowMatches,
      method: 'keyword',
    };
  }

  return {
    priority: 'medium',
    confidence: 0.5,
    matched_keywords: [],
    method: 'keyword',
  };
}

/**
 * Async wrapper — returns null on any error (non-blocking).
 * @param {string} title
 * @param {string} [description]
 * @returns {Promise<{priority: string, confidence: number, matched_keywords: string[], method: string}|null>}
 */
async function getSuggestedPriority(title, description) {
  try {
    return suggestPriority(title, description);
  } catch (err) {
    console.warn('autoPriorityService error (non-fatal):', err.message);
    return null;
  }
}

module.exports = { suggestPriority, getSuggestedPriority };
