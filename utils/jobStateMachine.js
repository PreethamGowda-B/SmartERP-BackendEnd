/**
 * Enterprise Job State Machine Engine
 * Defines canonical job states, valid state transitions, and RBAC rules.
 */

const JOB_STATES = {
  DRAFT: 'draft',
  PENDING_APPROVAL: 'pending_approval',
  ASSIGNED: 'assigned',
  ACCEPTED: 'accepted',
  IN_PROGRESS: 'in_progress',
  PAUSED: 'paused',
  WAITING_MATERIAL: 'waiting_material',
  WAITING_CUSTOMER: 'waiting_customer',
  COMPLETED: 'completed',
  UNDER_REVIEW: 'under_review',
  VERIFIED: 'verified',
  INVOICED: 'invoiced',
  PAID: 'paid',
  ARCHIVED: 'archived',
  CANCELLED: 'cancelled',
};

// Allowed state transitions map
const ALLOWED_TRANSITIONS = {
  [JOB_STATES.DRAFT]: [JOB_STATES.PENDING_APPROVAL, JOB_STATES.ASSIGNED, JOB_STATES.CANCELLED],
  [JOB_STATES.PENDING_APPROVAL]: [JOB_STATES.ASSIGNED, JOB_STATES.CANCELLED],
  [JOB_STATES.ASSIGNED]: [JOB_STATES.ACCEPTED, JOB_STATES.CANCELLED],
  [JOB_STATES.ACCEPTED]: [JOB_STATES.IN_PROGRESS, JOB_STATES.PAUSED, JOB_STATES.WAITING_MATERIAL, JOB_STATES.CANCELLED],
  [JOB_STATES.IN_PROGRESS]: [JOB_STATES.PAUSED, JOB_STATES.WAITING_MATERIAL, JOB_STATES.WAITING_CUSTOMER, JOB_STATES.COMPLETED, JOB_STATES.CANCELLED],
  [JOB_STATES.PAUSED]: [JOB_STATES.IN_PROGRESS, JOB_STATES.CANCELLED],
  [JOB_STATES.WAITING_MATERIAL]: [JOB_STATES.IN_PROGRESS, JOB_STATES.CANCELLED],
  [JOB_STATES.WAITING_CUSTOMER]: [JOB_STATES.IN_PROGRESS, JOB_STATES.CANCELLED],
  [JOB_STATES.COMPLETED]: [JOB_STATES.UNDER_REVIEW, JOB_STATES.VERIFIED, JOB_STATES.IN_PROGRESS],
  [JOB_STATES.UNDER_REVIEW]: [JOB_STATES.VERIFIED, JOB_STATES.IN_PROGRESS],
  [JOB_STATES.VERIFIED]: [JOB_STATES.INVOICED, JOB_STATES.ARCHIVED],
  [JOB_STATES.INVOICED]: [JOB_STATES.PAID, JOB_STATES.ARCHIVED],
  [JOB_STATES.PAID]: [JOB_STATES.ARCHIVED],
  [JOB_STATES.ARCHIVED]: [], // Terminal state
  [JOB_STATES.CANCELLED]: [], // Terminal state
};

/**
 * Validate state transition against RBAC rules and current state
 */
function validateStateTransition({ currentState, nextState, userRole, isOverride = false }) {
  const current = (currentState || JOB_STATES.ASSIGNED).toLowerCase();
  const next = (nextState || '').toLowerCase();

  if (!Object.values(JOB_STATES).includes(next)) {
    return { allowed: false, reason: `Invalid target state: ${nextState}` };
  }

  // Owner Emergency Override can transition to supervisory states with logged reason
  if (isOverride && userRole === 'owner') {
    return { allowed: true, isOverride: true };
  }

  // Standard transition check
  const allowedNextStates = ALLOWED_TRANSITIONS[current] || [];
  if (!allowedNextStates.includes(next)) {
    return {
      allowed: false,
      reason: `Cannot transition job state from '${current}' to '${next}'. Allowed next states: ${allowedNextStates.join(', ')}`,
    };
  }

  return { allowed: true };
}

module.exports = { JOB_STATES, ALLOWED_TRANSITIONS, validateStateTransition };
