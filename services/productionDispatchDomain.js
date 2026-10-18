const ORDER_STATUSES = Object.freeze({
  PLANNED: 'planned',
  IN_PRODUCTION: 'in_production',
  QUALITY_CHECK: 'quality_check',
  READY_FOR_DISPATCH: 'ready_for_dispatch',
  PARTIALLY_DISPATCHED: 'partially_dispatched',
  DISPATCHED: 'dispatched',
  ON_HOLD: 'on_hold',
  REWORK_REQUIRED: 'rework_required',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
});

const ROLE = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  EMPLOYEE: 'employee',
  HR: 'hr',
  QUALITY: 'quality',
});

const TRANSITIONS = Object.freeze({
  [ORDER_STATUSES.PLANNED]: new Set([
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.ON_HOLD,
    ORDER_STATUSES.CANCELLED,
  ]),
  [ORDER_STATUSES.IN_PRODUCTION]: new Set([
    ORDER_STATUSES.QUALITY_CHECK,
    ORDER_STATUSES.ON_HOLD,
    ORDER_STATUSES.CANCELLED,
  ]),
  [ORDER_STATUSES.QUALITY_CHECK]: new Set([
    ORDER_STATUSES.READY_FOR_DISPATCH,
    ORDER_STATUSES.REWORK_REQUIRED,
    ORDER_STATUSES.REJECTED,
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.CANCELLED,
  ]),
  [ORDER_STATUSES.READY_FOR_DISPATCH]: new Set([
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.PARTIALLY_DISPATCHED,
    ORDER_STATUSES.DISPATCHED,
    ORDER_STATUSES.ON_HOLD,
  ]),
  [ORDER_STATUSES.PARTIALLY_DISPATCHED]: new Set([
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.DISPATCHED,
    ORDER_STATUSES.ON_HOLD,
  ]),
  [ORDER_STATUSES.ON_HOLD]: new Set([
    ORDER_STATUSES.PLANNED,
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.QUALITY_CHECK,
    ORDER_STATUSES.READY_FOR_DISPATCH,
    ORDER_STATUSES.PARTIALLY_DISPATCHED,
    ORDER_STATUSES.CANCELLED,
  ]),
  [ORDER_STATUSES.REWORK_REQUIRED]: new Set([
    ORDER_STATUSES.IN_PRODUCTION,
    ORDER_STATUSES.QUALITY_CHECK,
    ORDER_STATUSES.REJECTED,
    ORDER_STATUSES.CANCELLED,
  ]),
  [ORDER_STATUSES.REJECTED]: new Set([ORDER_STATUSES.CANCELLED]),
  [ORDER_STATUSES.DISPATCHED]: new Set(),
  [ORDER_STATUSES.CANCELLED]: new Set(),
});

const PRIVILEGED_ROLES = new Set([ROLE.OWNER, ROLE.ADMIN, ROLE.HR]);
const INSPECTOR_ROLES = new Set([ROLE.OWNER, ROLE.ADMIN, ROLE.QUALITY]);

class ProductionRuleError extends Error {
  constructor(message, code = 'PRODUCTION_RULE_VIOLATION', status = 400) {
    super(message);
    this.name = 'ProductionRuleError';
    this.code = code;
    this.status = status;
  }
}

function quantity(value, fieldName, { allowZero = true } = {}) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed <= 0)) {
    throw new ProductionRuleError(`${fieldName} must be ${allowZero ? 'zero or greater' : 'greater than zero'}.`, 'INVALID_QUANTITY');
  }
  // The API and database should use a fixed numeric precision; normalize here so
  // callers do not accumulate floating point noise while reconciling batches.
  const rounded = Math.round((parsed + Number.EPSILON) * 1000) / 1000;
  if (Math.abs(parsed - rounded) > 0.000001) {
    throw new ProductionRuleError(`${fieldName} supports at most three decimal places.`, 'INVALID_QUANTITY_PRECISION');
  }
  return rounded;
}

function assertProductionReport({ plannedQuantity, priorGoodQuantity = 0, goodQuantity = 0, rejectedQuantity = 0, reworkQuantity = 0 }) {
  const planned = quantity(plannedQuantity, 'plannedQuantity', { allowZero: false });
  const priorGood = quantity(priorGoodQuantity, 'priorGoodQuantity');
  const good = quantity(goodQuantity, 'goodQuantity');
  const rejected = quantity(rejectedQuantity, 'rejectedQuantity');
  const rework = quantity(reworkQuantity, 'reworkQuantity');
  const reportTotal = good + rejected + rework;

  if (reportTotal <= 0) {
    throw new ProductionRuleError('A production report must record at least one unit.', 'EMPTY_PRODUCTION_REPORT');
  }
  if (priorGood + good - planned > 0.000001) {
    throw new ProductionRuleError('Good production cannot exceed the approved order quantity.', 'PRODUCTION_QUANTITY_EXCEEDED');
  }

  return Object.freeze({
    plannedQuantity: planned,
    priorGoodQuantity: priorGood,
    goodQuantity: good,
    rejectedQuantity: rejected,
    reworkQuantity: rework,
    attemptedQuantity: Math.round(reportTotal * 1000) / 1000,
    totalGoodQuantity: Math.round((priorGood + good) * 1000) / 1000,
    remainingPlannedQuantity: Math.round((planned - priorGood - good) * 1000) / 1000,
  });
}

function assertQualityOutcome({ submittedQuantity, acceptedQuantity = 0, rejectedQuantity = 0, reworkQuantity = 0, reason = '' }) {
  const submitted = quantity(submittedQuantity, 'submittedQuantity', { allowZero: false });
  const accepted = quantity(acceptedQuantity, 'acceptedQuantity');
  const rejected = quantity(rejectedQuantity, 'rejectedQuantity');
  const rework = quantity(reworkQuantity, 'reworkQuantity');
  const accounted = accepted + rejected + rework;

  if (Math.abs(accounted - submitted) > 0.000001) {
    throw new ProductionRuleError('Accepted, rejected, and rework quantities must equal the submitted quantity.', 'QUALITY_QUANTITY_MISMATCH');
  }
  if ((rejected > 0 || rework > 0) && !String(reason || '').trim()) {
    throw new ProductionRuleError('A reason is required when inspection rejects or returns quantity for rework.', 'QUALITY_REASON_REQUIRED');
  }

  const result = rejected === 0 && rework === 0
    ? 'passed'
    : accepted > 0
      ? 'partially_accepted'
      : rework > 0 && rejected === 0
        ? 'rework_required'
        : rejected > 0 && rework === 0
          ? 'rejected'
          : 'mixed_rework_and_rejection';

  return Object.freeze({ submittedQuantity: submitted, acceptedQuantity: accepted, rejectedQuantity: rejected, reworkQuantity: rework, result });
}

function assertDispatchQuantity({ acceptedQuantity, previouslyDispatchedQuantity = 0, cancelledQuantity = 0, requestedQuantity }) {
  const accepted = quantity(acceptedQuantity, 'acceptedQuantity');
  const dispatched = quantity(previouslyDispatchedQuantity, 'previouslyDispatchedQuantity');
  const cancelled = quantity(cancelledQuantity, 'cancelledQuantity');
  const requested = quantity(requestedQuantity, 'requestedQuantity', { allowZero: false });
  const available = Math.max(0, Math.round((accepted - dispatched - cancelled) * 1000) / 1000);

  if (dispatched + cancelled - accepted > 0.000001) {
    throw new ProductionRuleError('Existing dispatch and cancellation quantities exceed accepted quantity.', 'DISPATCH_LEDGER_INCONSISTENT');
  }
  if (requested - available > 0.000001) {
    throw new ProductionRuleError('Dispatch quantity exceeds accepted, undispatched quantity.', 'DISPATCH_QUANTITY_EXCEEDED');
  }

  const remaining = Math.round((available - requested) * 1000) / 1000;
  return Object.freeze({ acceptedQuantity: accepted, previouslyDispatchedQuantity: dispatched, cancelledQuantity: cancelled, requestedQuantity: requested, remainingDispatchableQuantity: remaining, complete: remaining === 0 });
}

function assertPackingQuantity({ acceptedQuantity, previouslyPackedQuantity = 0, requestedQuantity }) {
  const accepted = quantity(acceptedQuantity, 'acceptedQuantity');
  const packed = quantity(previouslyPackedQuantity, 'previouslyPackedQuantity');
  const requested = quantity(requestedQuantity, 'requestedQuantity', { allowZero: false });
  const available = Math.max(0, Math.round((accepted - packed) * 1000) / 1000);
  if (packed - accepted > 0.000001) {
    throw new ProductionRuleError('Existing packing quantity exceeds accepted inspection quantity.', 'PACKING_LEDGER_INCONSISTENT');
  }
  if (requested - available > 0.000001) {
    throw new ProductionRuleError('Packing quantity exceeds accepted, unpacked quantity.', 'PACKING_QUANTITY_EXCEEDED');
  }
  return Object.freeze({ acceptedQuantity: accepted, previouslyPackedQuantity: packed, requestedQuantity: requested, remainingPackableQuantity: Math.round((available - requested) * 1000) / 1000 });
}

function assertPackingStatusTransition({ fromStatus, toStatus }) {
  const from = String(fromStatus || '').toLowerCase();
  const to = String(toStatus || '').toLowerCase();
  const transitions = { packing: 'packed', packed: 'ready_for_dispatch' };
  if (transitions[from] !== to) {
    throw new ProductionRuleError('Packing must move from packing to packed, then to ready for dispatch.', 'INVALID_PACKING_TRANSITION');
  }
  return Object.freeze({ fromStatus: from, toStatus: to });
}

function assertPackingDispatchPermission({ actorRole, actorId, assignedDispatchEmployeeId }) {
  const role = String(actorRole || '').toLowerCase();
  const isOwner = ['owner', 'admin'].includes(role);
  const isEmployee = ['employee', 'staff', 'technician'].includes(role);
  if (!isOwner && !(isEmployee && String(actorId || '') === String(assignedDispatchEmployeeId || ''))) {
    throw new ProductionRuleError('Only an Owner/Admin or the employee assigned to dispatch this order can pack or dispatch it.', 'DISPATCH_ROLE_FORBIDDEN', 403);
  }
  return true;
}

function assertStatusTransition({ fromStatus, toStatus, actorRole, actorId, assignedEmployeeId, reason = '', hasProductionReport = false, qualityReleasedQuantity = 0, dispatchRecorded = false }) {
  const from = String(fromStatus || '').toLowerCase();
  const to = String(toStatus || '').toLowerCase();
  const role = String(actorRole || '').toLowerCase();
  const validStatuses = Object.values(ORDER_STATUSES);

  if (!validStatuses.includes(from) || !validStatuses.includes(to) || !TRANSITIONS[from]?.has(to)) {
    throw new ProductionRuleError(`Transition from '${from}' to '${to}' is not allowed.`, 'INVALID_STATUS_TRANSITION');
  }

  const isAssignedEmployee = role === ROLE.EMPLOYEE && String(actorId || '') === String(assignedEmployeeId || '');
  const isInspector = INSPECTOR_ROLES.has(role);
  const isPrivileged = PRIVILEGED_ROLES.has(role);

  if (to === ORDER_STATUSES.IN_PRODUCTION && !(isAssignedEmployee || isPrivileged)) {
    throw new ProductionRuleError('Only the assigned employee or an Owner/Admin/HR can start or resume production.', 'PRODUCTION_ROLE_FORBIDDEN');
  }
  if (to === ORDER_STATUSES.QUALITY_CHECK && !(isAssignedEmployee || isPrivileged)) {
    throw new ProductionRuleError('Only the assigned employee or an Owner/Admin/HR can submit production for inspection.', 'PRODUCTION_ROLE_FORBIDDEN');
  }
  if (to === ORDER_STATUSES.READY_FOR_DISPATCH && !isInspector) {
    throw new ProductionRuleError('Only an authorized inspector can release quantity for dispatch.', 'QUALITY_ROLE_FORBIDDEN');
  }
  if (to === ORDER_STATUSES.READY_FOR_DISPATCH && quantity(qualityReleasedQuantity, 'qualityReleasedQuantity') <= 0) {
    throw new ProductionRuleError('Dispatch release requires accepted inspection quantity.', 'QUALITY_RELEASE_REQUIRED');
  }
  if ([ORDER_STATUSES.PARTIALLY_DISPATCHED, ORDER_STATUSES.DISPATCHED].includes(to) && !dispatchRecorded) {
    throw new ProductionRuleError('Dispatch status must be derived from a persisted dispatch record.', 'DISPATCH_RECORD_REQUIRED');
  }
  if (to === ORDER_STATUSES.QUALITY_CHECK && !hasProductionReport) {
    throw new ProductionRuleError('Production must be reported before submitting the batch for inspection.', 'PRODUCTION_REPORT_REQUIRED');
  }
  if ([ORDER_STATUSES.ON_HOLD, ORDER_STATUSES.REJECTED, ORDER_STATUSES.CANCELLED, ORDER_STATUSES.REWORK_REQUIRED].includes(to) && !String(reason || '').trim()) {
    throw new ProductionRuleError('A reason is required for hold, rejection, rework, or cancellation.', 'STATUS_REASON_REQUIRED');
  }
  if (!isPrivileged && !isInspector && !isAssignedEmployee) {
    throw new ProductionRuleError('You are not authorized to update this production order.', 'PRODUCTION_ROLE_FORBIDDEN');
  }

  return Object.freeze({ fromStatus: from, toStatus: to, actorRole: role });
}

function deriveDispatchStatus({ acceptedQuantity, dispatchedQuantity, cancelledQuantity = 0 }) {
  const accepted = quantity(acceptedQuantity, 'acceptedQuantity');
  const dispatched = quantity(dispatchedQuantity, 'dispatchedQuantity');
  const cancelled = quantity(cancelledQuantity, 'cancelledQuantity');
  if (dispatched + cancelled - accepted > 0.000001) {
    throw new ProductionRuleError('Dispatch ledger exceeds accepted quantity.', 'DISPATCH_LEDGER_INCONSISTENT');
  }
  if (dispatched === accepted && accepted > 0) return ORDER_STATUSES.DISPATCHED;
  if (dispatched > 0) return ORDER_STATUSES.PARTIALLY_DISPATCHED;
  if (accepted > 0 && cancelled >= accepted) return ORDER_STATUSES.CANCELLED;
  return accepted > 0 ? ORDER_STATUSES.READY_FOR_DISPATCH : null;
}

module.exports = {
  ORDER_STATUSES,
  ROLE,
  ProductionRuleError,
  assertProductionReport,
  assertQualityOutcome,
  assertDispatchQuantity,
  assertPackingQuantity,
  assertPackingStatusTransition,
  assertPackingDispatchPermission,
  assertStatusTransition,
  deriveDispatchStatus,
};
