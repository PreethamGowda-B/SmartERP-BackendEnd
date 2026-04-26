/**
 * services/aiPriorityService.js
 *
 * AI-Based Job Prioritization
 *
 * Analyzes job description keywords to suggest a priority level.
 * Structured to support future ML/historical data improvements.
 *
 * Current implementation: keyword-based scoring
 * Future: can be replaced with ML model without changing the interface
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

// ─── Suggest priority from text ───────────────────────────────────────────────
/**
 * Analyze job title + description and return a suggested priority.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {{ priority: 'high'|'medium'|'low', confidence: number, matched_keywords: string[] }}
 */
function suggestPriority(title = '', description = '') {
  const text = `${title} ${description}`.toLowerCase();

  const highMatches = HIGH_PRIORITY_KEYWORDS.filter((kw) => text.includes(kw));
  const lowMatches  = LOW_PRIORITY_KEYWORDS.filter((kw) => text.includes(kw));

  // High priority wins if any high keyword is found
  if (highMatches.length > 0) {
    return {
      priority: 'high',
      confidence: Math.min(1.0, highMatches.length * 0.3),
      matched_keywords: highMatches,
    };
  }

  // Low priority if low keywords found and no high keywords
  if (lowMatches.length > 0) {
    return {
      priority: 'low',
      confidence: Math.min(1.0, lowMatches.length * 0.3),
      matched_keywords: lowMatches,
    };
  }

  // Default to medium
  return {
    priority: 'medium',
    confidence: 0.5,
    matched_keywords: [],
  };
}

/**
 * Non-blocking wrapper — returns null on any error.
 * Designed to be called fire-and-forget or with optional await.
 *
 * @param {string} title
 * @param {string} [description]
 * @returns {Promise<{priority: string, confidence: number, matched_keywords: string[]}|null>}
 */
async function getSuggestedPriority(title, description) {
  try {
    return suggestPriority(title, description);
  } catch (err) {
    console.warn('aiPriorityService error (non-fatal):', err.message);
    return null;
  }
}

module.exports = { suggestPriority, getSuggestedPriority };
