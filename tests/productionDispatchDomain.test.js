const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ORDER_STATUSES: S,
  ProductionRuleError,
  assertProductionReport,
  assertQualityOutcome,
  assertDispatchQuantity,
  assertPackingQuantity,
  assertPackingStatusTransition,
  assertPackingDispatchPermission,
  assertStatusTransition,
  deriveDispatchStatus,
} = require('../services/productionDispatchDomain');

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof ProductionRuleError && error.code === code);
}

test('good quantity reconciles against the approved plan while scrap and rework attempts remain visible', () => {
  assert.deepEqual(
    assertProductionReport({ plannedQuantity: 100, priorGoodQuantity: 35, goodQuantity: 65, rejectedQuantity: 5, reworkQuantity: 10 }),
    {
      plannedQuantity: 100,
      priorGoodQuantity: 35,
      goodQuantity: 65,
      rejectedQuantity: 5,
      reworkQuantity: 10,
      attemptedQuantity: 80,
      totalGoodQuantity: 100,
      remainingPlannedQuantity: 0,
    },
  );
  expectCode(() => assertProductionReport({ plannedQuantity: 10, priorGoodQuantity: 8, goodQuantity: 3, rejectedQuantity: 1 }), 'PRODUCTION_QUANTITY_EXCEEDED');
  expectCode(() => assertProductionReport({ plannedQuantity: 10 }), 'EMPTY_PRODUCTION_REPORT');
});

test('quantity validation rejects negative, non-finite, and unsupported precision values', () => {
  expectCode(() => assertProductionReport({ plannedQuantity: 10, goodQuantity: -1 }), 'INVALID_QUANTITY');
  expectCode(() => assertProductionReport({ plannedQuantity: 10, goodQuantity: Number.NaN }), 'INVALID_QUANTITY');
  expectCode(() => assertProductionReport({ plannedQuantity: 10, goodQuantity: 1.0001 }), 'INVALID_QUANTITY_PRECISION');
});

test('inspection quantities must account for the full submitted batch', () => {
  assert.equal(assertQualityOutcome({ submittedQuantity: 10, acceptedQuantity: 7, rejectedQuantity: 1, reworkQuantity: 2, reason: 'Bore dimension out of tolerance' }).result, 'partially_accepted');
  expectCode(() => assertQualityOutcome({ submittedQuantity: 10, acceptedQuantity: 7, rejectedQuantity: 1 }), 'QUALITY_QUANTITY_MISMATCH');
});

test('failed or rework inspection requires a reason and preserves an explicit outcome', () => {
  expectCode(() => assertQualityOutcome({ submittedQuantity: 4, rejectedQuantity: 4 }), 'QUALITY_REASON_REQUIRED');
  assert.equal(assertQualityOutcome({ submittedQuantity: 4, reworkQuantity: 4, reason: 'Thread needs re-cut' }).result, 'rework_required');
  assert.equal(assertQualityOutcome({ submittedQuantity: 4, rejectedQuantity: 4, reason: 'Cracked part' }).result, 'rejected');
  assert.equal(assertQualityOutcome({ submittedQuantity: 4, acceptedQuantity: 4 }).result, 'passed');
});

test('partial and final dispatches reconcile only accepted, undispatched quantity', () => {
  assert.deepEqual(assertDispatchQuantity({ acceptedQuantity: 100, requestedQuantity: 60 }), {
    acceptedQuantity: 100,
    previouslyDispatchedQuantity: 0,
    cancelledQuantity: 0,
    requestedQuantity: 60,
    remainingDispatchableQuantity: 40,
    complete: false,
  });
  assert.equal(assertDispatchQuantity({ acceptedQuantity: 100, previouslyDispatchedQuantity: 60, requestedQuantity: 40 }).complete, true);
  expectCode(() => assertDispatchQuantity({ acceptedQuantity: 100, requestedQuantity: 101 }), 'DISPATCH_QUANTITY_EXCEEDED');
  expectCode(() => assertDispatchQuantity({ acceptedQuantity: 0, requestedQuantity: 1 }), 'DISPATCH_QUANTITY_EXCEEDED');
  expectCode(() => assertDispatchQuantity({ acceptedQuantity: 100, requestedQuantity: 0 }), 'INVALID_QUANTITY');
});

test('dispatch ledger inconsistencies fail closed', () => {
  expectCode(() => assertDispatchQuantity({ acceptedQuantity: 10, previouslyDispatchedQuantity: 9, cancelledQuantity: 2, requestedQuantity: 1 }), 'DISPATCH_LEDGER_INCONSISTENT');
  expectCode(() => deriveDispatchStatus({ acceptedQuantity: 10, dispatchedQuantity: 8, cancelledQuantity: 3 }), 'DISPATCH_LEDGER_INCONSISTENT');
});

test('packing quantity is bounded by quality-accepted quantity and existing packs', () => {
  assert.deepEqual(assertPackingQuantity({ acceptedQuantity: 20, previouslyPackedQuantity: 8, requestedQuantity: 12 }), {
    acceptedQuantity: 20, previouslyPackedQuantity: 8, requestedQuantity: 12, remainingPackableQuantity: 0,
  });
  expectCode(() => assertPackingQuantity({ acceptedQuantity: 20, previouslyPackedQuantity: 12, requestedQuantity: 9 }), 'PACKING_QUANTITY_EXCEEDED');
  expectCode(() => assertPackingQuantity({ acceptedQuantity: 10, previouslyPackedQuantity: 11, requestedQuantity: 1 }), 'PACKING_LEDGER_INCONSISTENT');
  expectCode(() => assertPackingQuantity({ acceptedQuantity: 10, requestedQuantity: 1.0001 }), 'INVALID_QUANTITY_PRECISION');
});

test('packing records advance only from packing to packed to ready for dispatch', () => {
  assert.equal(assertPackingStatusTransition({ fromStatus: 'packing', toStatus: 'packed' }).toStatus, 'packed');
  assert.equal(assertPackingStatusTransition({ fromStatus: 'packed', toStatus: 'ready_for_dispatch' }).toStatus, 'ready_for_dispatch');
  expectCode(() => assertPackingStatusTransition({ fromStatus: 'packing', toStatus: 'ready_for_dispatch' }), 'INVALID_PACKING_TRANSITION');
  expectCode(() => assertPackingStatusTransition({ fromStatus: 'ready_for_dispatch', toStatus: 'packed' }), 'INVALID_PACKING_TRANSITION');
});

test('packing and dispatch are restricted to Owner/Admin or the assigned dispatch employee', () => {
  assert.equal(assertPackingDispatchPermission({ actorRole: 'employee', actorId: 'worker-1', assignedDispatchEmployeeId: 'worker-1' }), true);
  assert.equal(assertPackingDispatchPermission({ actorRole: 'owner', actorId: 'owner-1' }), true);
  assert.equal(assertPackingDispatchPermission({ actorRole: 'admin', actorId: 'admin-1' }), true);
  expectCode(() => assertPackingDispatchPermission({ actorRole: 'employee', actorId: 'worker-2', assignedDispatchEmployeeId: 'worker-1' }), 'DISPATCH_ROLE_FORBIDDEN');
  expectCode(() => assertPackingDispatchPermission({ actorRole: 'employee', actorId: 'worker-1', assignedDispatchEmployeeId: null }), 'DISPATCH_ROLE_FORBIDDEN');
});

test('dispatch status derives from recorded quantities and partial shipment', () => {
  assert.equal(deriveDispatchStatus({ acceptedQuantity: 10, dispatchedQuantity: 0 }), S.READY_FOR_DISPATCH);
  assert.equal(deriveDispatchStatus({ acceptedQuantity: 10, dispatchedQuantity: 4 }), S.PARTIALLY_DISPATCHED);
  assert.equal(deriveDispatchStatus({ acceptedQuantity: 10, dispatchedQuantity: 8, cancelledQuantity: 2 }), S.PARTIALLY_DISPATCHED);
  assert.equal(deriveDispatchStatus({ acceptedQuantity: 10, dispatchedQuantity: 0, cancelledQuantity: 10 }), S.CANCELLED);
  assert.equal(deriveDispatchStatus({ acceptedQuantity: 0, dispatchedQuantity: 0 }), null);
});

test('only defined lifecycle transitions are accepted', () => {
  assert.equal(assertStatusTransition({ fromStatus: S.PLANNED, toStatus: S.IN_PRODUCTION, actorRole: 'employee', actorId: 'u-1', assignedEmployeeId: 'u-1' }).toStatus, S.IN_PRODUCTION);
  expectCode(() => assertStatusTransition({ fromStatus: S.PLANNED, toStatus: S.DISPATCHED, actorRole: 'owner', dispatchRecorded: true }), 'INVALID_STATUS_TRANSITION');
  expectCode(() => assertStatusTransition({ fromStatus: S.IN_PRODUCTION, toStatus: S.PLANNED, actorRole: 'owner' }), 'INVALID_STATUS_TRANSITION');
});

test('employee can start only assigned work and cannot perform inspection release', () => {
  expectCode(() => assertStatusTransition({ fromStatus: S.PLANNED, toStatus: S.IN_PRODUCTION, actorRole: 'employee', actorId: 'u-2', assignedEmployeeId: 'u-1' }), 'PRODUCTION_ROLE_FORBIDDEN');
  expectCode(() => assertStatusTransition({ fromStatus: S.QUALITY_CHECK, toStatus: S.READY_FOR_DISPATCH, actorRole: 'employee', actorId: 'u-1', assignedEmployeeId: 'u-1', qualityReleasedQuantity: 5 }), 'QUALITY_ROLE_FORBIDDEN');
});

test('quality release requires an authorized inspector and accepted quantity', () => {
  expectCode(() => assertStatusTransition({ fromStatus: S.QUALITY_CHECK, toStatus: S.READY_FOR_DISPATCH, actorRole: 'owner' }), 'QUALITY_RELEASE_REQUIRED');
  assert.equal(assertStatusTransition({ fromStatus: S.QUALITY_CHECK, toStatus: S.READY_FOR_DISPATCH, actorRole: 'quality', qualityReleasedQuantity: 10 }).toStatus, S.READY_FOR_DISPATCH);
});

test('quality submission requires production evidence and dispatch state requires a persisted record', () => {
  expectCode(() => assertStatusTransition({ fromStatus: S.IN_PRODUCTION, toStatus: S.QUALITY_CHECK, actorRole: 'employee', actorId: 'u-1', assignedEmployeeId: 'u-1' }), 'PRODUCTION_REPORT_REQUIRED');
  expectCode(() => assertStatusTransition({ fromStatus: S.READY_FOR_DISPATCH, toStatus: S.PARTIALLY_DISPATCHED, actorRole: 'owner' }), 'DISPATCH_RECORD_REQUIRED');
});

test('hold, rejection, rework, and cancellation require an audit reason', () => {
  expectCode(() => assertStatusTransition({ fromStatus: S.PLANNED, toStatus: S.ON_HOLD, actorRole: 'owner' }), 'STATUS_REASON_REQUIRED');
  assert.equal(assertStatusTransition({ fromStatus: S.PLANNED, toStatus: S.ON_HOLD, actorRole: 'owner', reason: 'Awaiting material' }).toStatus, S.ON_HOLD);
});

test('terminal dispatched and cancelled orders cannot transition again', () => {
  expectCode(() => assertStatusTransition({ fromStatus: S.DISPATCHED, toStatus: S.ON_HOLD, actorRole: 'owner', reason: 'test' }), 'INVALID_STATUS_TRANSITION');
  expectCode(() => assertStatusTransition({ fromStatus: S.CANCELLED, toStatus: S.PLANNED, actorRole: 'owner' }), 'INVALID_STATUS_TRANSITION');
});

test('accepted work awaiting dispatch can continue production against the remaining planned quantity', () => {
  assert.equal(assertStatusTransition({
    fromStatus: S.READY_FOR_DISPATCH,
    toStatus: S.IN_PRODUCTION,
    actorRole: 'employee',
    actorId: 'u-1',
    assignedEmployeeId: 'u-1',
  }).toStatus, S.IN_PRODUCTION);
  assert.equal(assertStatusTransition({
    fromStatus: S.PARTIALLY_DISPATCHED,
    toStatus: S.IN_PRODUCTION,
    actorRole: 'employee',
    actorId: 'u-1',
    assignedEmployeeId: 'u-1',
  }).toStatus, S.IN_PRODUCTION);
});


test('production route handlers do not lock append-only tables FOR UPDATE without UPDATE privileges', () => {
  const fs = require('fs');
  const path = require('path');
  const code = fs.readFileSync(path.join(__dirname, '../routes/production.js'), 'utf8');

  // Verify production_inspections is not queried with FOR UPDATE (append-only table)
  assert.doesNotMatch(
    code,
    /production_inspections\s+WHERE[^;]+FOR\s+UPDATE/i,
    'production_inspections is an append-only ledger; querying FOR UPDATE fails with 42501 for smarterp_app'
  );

  // Verify production_dispatches join does not attempt FOR UPDATE OF d (append-only table)
  assert.doesNotMatch(
    code,
    /production_dispatches\s+d[^;]+FOR\s+UPDATE\s+OF\s+d/i,
    'production_dispatches is an append-only ledger; locking table d fails with 42501 for smarterp_app'
  );
});
