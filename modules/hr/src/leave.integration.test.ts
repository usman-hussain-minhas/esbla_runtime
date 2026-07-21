import { evaluatePolicy, setServiceActivation, withTenantTransaction } from "@esbla/platform-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveLeaveRequest,
  getLeaveRequest,
  getLeaveRequestDetail,
  HR_LEAVE_BILLING_STATE,
  listAssignedLeaveRequests,
  listLeaveEvidence,
  listOwnLeaveRequests,
  rejectLeaveRequest,
  submitLeaveRequest,
} from "./index.js";
import {
  awaitControlledSignal,
  context,
  createControlledPool,
  deleteSetting,
  expectAnyBackendBlockedBy,
  expectBackendBlockedBy,
  expectDeniedWithoutPersistenceChange,
  ids,
  matchesLeaveSelector,
  migrationPool,
  observeDirectBlockerUntil,
  pool,
  setBooleanSetting,
  setManagerAState,
  setupLeaveIntegration,
  snapshotLeavePersistence,
} from "./leave.integration-fixture.js";

beforeAll(async () => {
  await setupLeaveIntegration();
});

afterAll(async () => {
  await pool.end();
  await migrationPool.end();
});

describe("HR Leave Request domain", () => {
  it("applies the schema with forced RLS and declared query indexes", async () => {
    const migrations = await migrationPool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations",
    );
    expect(migrations.rows[0]?.count).toBe("7");
    const table = await migrationPool.query<{
      force_row_security: boolean;
      row_security: boolean;
    }>(
      `SELECT relrowsecurity AS row_security, relforcerowsecurity AS force_row_security
       FROM pg_class WHERE oid = 'hr_leave_requests'::regclass`,
    );
    expect(table.rows).toEqual([{ force_row_security: true, row_security: true }]);
    const indexes = await migrationPool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'hr_leave_requests' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "hr_leave_requests_assigned_open_idx",
      "hr_leave_requests_employee_history_idx",
      "hr_leave_requests_pkey",
      "hr_leave_requests_tenant_employee_idempotency_uq",
    ]);
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.adminA, ids.correlationActivateA),
        async ({ client }) => {
          await client.query(
            `INSERT INTO hr_leave_requests
               (leave_request_id, tenant_id, employee_principal_id, approver_principal_id,
                category_code, start_date, end_date, status, decided_at,
                idempotency_key, correlation_id)
             VALUES ('30000000-0000-4000-8000-000000000099', $1, $2, $3,
                     'other', '2026-01-01', '2026-01-01', 'approved', now(),
                     'illegal-terminal-insert', $4)`,
            [ids.tenantA, ids.employeeA, ids.managerA, ids.correlationActivateA],
          );
        },
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantB, ids.employeeB, ids.correlationSubmitB),
        async ({ client }) => {
          await client.query(
            `INSERT INTO hr_leave_requests
               (leave_request_id, tenant_id, employee_principal_id, approver_principal_id,
                category_code, start_date, end_date, idempotency_key, correlation_id)
             VALUES ($1, $2, $3, $4, 'other', '2026-01-01', '2026-01-01',
                     'cross-tenant-probe', $5)`,
            [ids.requestRlsProbe, ids.tenantA, ids.employeeB, ids.managerB, ids.correlationSubmitB],
          );
        },
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("submits once, couples work and proof atomically, and replays idempotently", async () => {
    const input = {
      categoryCode: "sick" as const,
      endDate: "2026-07-13",
      idempotencyKey: "leave-request-1",
      leaveRequestId: ids.request1,
      startDate: "2026-07-13",
    };
    const submitted = await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
      input,
    );
    expect(submitted).toMatchObject({
      billingState: HR_LEAVE_BILLING_STATE,
      replayed: false,
      request: {
        approverPrincipalId: ids.managerA,
        employeePrincipalId: ids.employeeA,
        leaveRequestId: ids.request1,
        status: "submitted",
        version: 1,
      },
    });
    const replay = await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
      input,
    );
    expect(replay).toMatchObject({ replayed: true, request: { leaveRequestId: ids.request1 } });
    await expect(
      submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA, ids.correlationSubmit1), {
        ...input,
        reason: "changed",
      }),
    ).rejects.toMatchObject({ code: "LEAVE_IDEMPOTENCY_CONFLICT" });

    const assigned = await listAssignedLeaveRequests(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationSubmit1),
    );
    const assignedItem = assigned.find((item) => item.leaveRequestId === ids.request1);
    expect(assignedItem).toMatchObject({
      categoryCode: "sick",
      employeeDisplayName: "Employee A",
      leaveRequestId: ids.request1,
      version: 1,
      workItemId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(Object.keys(assignedItem ?? {}).sort()).toEqual(
      [
        "categoryCode",
        "employeeDisplayName",
        "endDate",
        "leaveRequestId",
        "reason",
        "startDate",
        "submittedAt",
        "version",
        "workItemId",
      ].sort(),
    );

    const detail = await getLeaveRequestDetail(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationSubmit1),
      ids.request1,
    );
    expect(detail?.request).toMatchObject({
      categoryCode: "sick",
      employeeDisplayName: "Employee A",
      leaveRequestId: ids.request1,
      status: "submitted",
      version: 1,
    });
    expect(Object.keys(detail?.request ?? {}).sort()).toEqual(
      [
        "categoryCode",
        "decidedAt",
        "decisionNote",
        "employeeDisplayName",
        "endDate",
        "leaveRequestId",
        "reason",
        "startDate",
        "status",
        "submittedAt",
        "version",
      ].sort(),
    );
    expect(detail?.history).toEqual([
      expect.objectContaining({
        eventType: "evidence.hr.leave_request.submitted",
        newState: "submitted",
        priorState: null,
      }),
    ]);
    expect(Object.keys(detail?.history[0] ?? {}).sort()).toEqual(
      ["eventType", "newState", "occurredAt", "priorState"].sort(),
    );

    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
      async ({ client }) => {
        const counts = await client.query<{
          evidence_count: string;
          outbox_count: string;
          work_count: string;
        }>(
          `SELECT
             (SELECT count(*) FROM evidence_events WHERE subject_type = 'hr.leave_request' AND subject_id = $1)::text AS evidence_count,
             (SELECT count(*) FROM outbox_events WHERE aggregate_type = 'hr.leave_request' AND aggregate_id = $1)::text AS outbox_count,
             (SELECT count(*) FROM work_items WHERE subject_type = 'hr.leave_request' AND subject_id = $1)::text AS work_count`,
          [ids.request1],
        );
        expect(counts.rows[0]).toEqual({
          evidence_count: "1",
          outbox_count: "1",
          work_count: "1",
        });
        const outbox = await client.query<{ payload: Record<string, unknown> }>(
          "SELECT payload FROM outbox_events WHERE aggregate_id = $1",
          [ids.request1],
        );
        expect(outbox.rows[0]?.payload).not.toHaveProperty("reason");
      },
    );
  });

  it("serializes concurrent submissions on the domain idempotency key", async () => {
    const input = {
      categoryCode: "other" as const,
      endDate: "2026-07-20",
      idempotencyKey: "concurrent-submission",
      leaveRequestId: ids.requestConcurrent,
      startDate: "2026-07-20",
    };
    const results = await Promise.all([
      submitLeaveRequest(
        pool,
        context(ids.tenantA, ids.employeeA2, ids.correlationConcurrentSubmit),
        input,
      ),
      submitLeaveRequest(
        pool,
        context(ids.tenantA, ids.employeeA2, ids.correlationConcurrentSubmit),
        input,
      ),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationConcurrentSubmit),
      async ({ client }) => {
        const counts = await client.query<{
          evidence_count: string;
          request_count: string;
          work_count: string;
        }>(
          `SELECT
             (SELECT count(*) FROM hr_leave_requests WHERE leave_request_id = $1)::text AS request_count,
             (SELECT count(*) FROM evidence_events WHERE subject_id = $1)::text AS evidence_count,
             (SELECT count(*) FROM work_items WHERE subject_id = $1)::text AS work_count`,
          [ids.requestConcurrent],
        );
        expect(counts.rows[0]).toEqual({
          evidence_count: "1",
          request_count: "1",
          work_count: "1",
        });
      },
    );
  });

  it("enforces dates, tenant settings, and the self-approval floor", async () => {
    await expect(
      submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA, ids.correlationSubmit2), {
        categoryCode: "annual",
        endDate: "2026-02-29",
        idempotencyKey: "bad-date",
        startDate: "2026-03-01",
      }),
    ).rejects.toMatchObject({ code: "LEAVE_INPUT_INVALID" });

    await setBooleanSetting(ids.tenantA, "hr.leave.require_reason", true);
    await expect(
      submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA, ids.correlationSubmit2), {
        categoryCode: "annual",
        endDate: "2026-08-04",
        idempotencyKey: "leave-request-2",
        leaveRequestId: ids.request2,
        startDate: "2026-08-03",
      }),
    ).rejects.toMatchObject({ code: "LEAVE_INPUT_INVALID" });
    const submitted = await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit2),
      {
        categoryCode: "annual",
        endDate: "2026-08-04",
        idempotencyKey: "leave-request-2",
        leaveRequestId: ids.request2,
        reason: "Family commitment",
        startDate: "2026-08-03",
      },
    );
    expect(submitted.request.reason).toBe("Family commitment");
    await deleteSetting(ids.tenantA, "hr.leave.require_reason");

    await expect(
      submitLeaveRequest(pool, context(ids.tenantA, ids.managerA2, ids.correlationSubmitSelf), {
        categoryCode: "other",
        endDate: "2026-09-01",
        idempotencyKey: "self-manager-request",
        startDate: "2026-09-01",
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  it("allows only the assigned manager to approve and makes terminal state immutable", async () => {
    await expect(
      approveLeaveRequest(pool, context(ids.tenantA, ids.managerA2, ids.correlationApprove1), {
        expectedVersion: 1,
        leaveRequestId: ids.request1,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    const approved = await approveLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationApprove1),
      { expectedVersion: 1, leaveRequestId: ids.request1 },
    );
    expect(approved).toMatchObject({
      replayed: false,
      request: { status: "approved", version: 2 },
    });
    const replay = await approveLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationApprove1),
      { expectedVersion: 1, leaveRequestId: ids.request1 },
    );
    expect(replay).toMatchObject({ replayed: true, request: { status: "approved", version: 2 } });
    await expect(
      approveLeaveRequest(pool, context(ids.tenantA, ids.managerA, ids.correlationApproveRetry), {
        expectedVersion: 2,
        leaveRequestId: ids.request1,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_STATE_CONFLICT" });
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationApproveRetry),
        async ({ client }) =>
          await client.query(
            `UPDATE hr_leave_requests
             SET status = 'rejected', version = version + 1, decided_at = now()
             WHERE leave_request_id = $1`,
            [ids.request1],
          ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      withTenantTransaction(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationApproveRetry),
        async ({ client }) =>
          await client.query("DELETE FROM hr_leave_requests WHERE leave_request_id = $1", [
            ids.request1,
          ]),
      ),
    ).rejects.toMatchObject({ code: "55000" });

    const history = await listLeaveEvidence(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationApproveRetry),
      ids.request1,
    );
    expect(history.map((event) => event.newState)).toEqual(["submitted", "approved"]);
    const firstEvidencePage = await listLeaveEvidence(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationApproveRetry),
      ids.request1,
      { pageSize: 1 },
    );
    const firstEvidence = firstEvidencePage[0];
    expect(firstEvidence).toBeDefined();
    const secondEvidencePage = await listLeaveEvidence(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationApproveRetry),
      ids.request1,
      {
        cursor: {
          evidenceEventId: firstEvidence?.evidenceEventId ?? "",
          occurredAt: firstEvidence?.occurredAt ?? "",
        },
        pageSize: 1,
      },
    );
    expect(secondEvidencePage[0]?.newState).toBe("approved");
    const assigned = await listAssignedLeaveRequests(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationApproveRetry),
    );
    expect(assigned.some((request) => request.leaveRequestId === ids.request1)).toBe(false);
  });

  it("enforces rejection-note policy and completes the assigned work item", async () => {
    await expect(
      rejectLeaveRequest(pool, context(ids.tenantA, ids.managerA, ids.correlationReject2), {
        expectedVersion: 1,
        leaveRequestId: ids.request2,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_INPUT_INVALID" });
    const rejected = await rejectLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationReject2),
      {
        decisionNote: "Coverage is unavailable for these dates.",
        expectedVersion: 1,
        leaveRequestId: ids.request2,
      },
    );
    expect(rejected).toMatchObject({
      request: {
        decisionNote: "Coverage is unavailable for these dates.",
        status: "rejected",
        version: 2,
      },
    });
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationReject2),
      async ({ client }) => {
        const work = await client.query<{ completed_at: Date; status: string }>(
          "SELECT status, completed_at FROM work_items WHERE subject_id = $1",
          [ids.request2],
        );
        expect(work.rows[0]?.status).toBe("completed");
        expect(work.rows[0]?.completed_at).toBeInstanceOf(Date);
      },
    );
  });

  it("honors the tenant override that makes a rejection note optional", async () => {
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmitOptional),
      {
        categoryCode: "annual",
        endDate: "2027-03-12",
        idempotencyKey: "optional-rejection-note",
        leaveRequestId: ids.requestOptionalReject,
        startDate: "2027-03-12",
      },
    );
    await setBooleanSetting(ids.tenantA, "hr.leave.reject_note_required", false);
    try {
      const rejected = await rejectLeaveRequest(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationRejectOptional),
        {
          expectedVersion: 1,
          leaveRequestId: ids.requestOptionalReject,
        },
      );
      expect(rejected.request).toMatchObject({
        decisionNote: null,
        status: "rejected",
        version: 2,
      });
    } finally {
      await deleteSetting(ids.tenantA, "hr.leave.reject_note_required");
    }
  });

  it("requires current manager authority across assigned reads, decisions, and replays", async () => {
    const leaveRequestIds = [
      ids.requestDemotionView,
      ids.requestDemotionApprove,
      ids.requestDemotionReject,
      ids.requestDemotionReplayApprove,
      ids.requestDemotionReplayReject,
    ] as const;

    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitView),
      {
        categoryCode: "other",
        endDate: "2027-01-04",
        idempotencyKey: "demotion-view",
        leaveRequestId: ids.requestDemotionView,
        startDate: "2027-01-04",
      },
    );
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitApprove),
      {
        categoryCode: "annual",
        endDate: "2027-01-05",
        idempotencyKey: "demotion-approve",
        leaveRequestId: ids.requestDemotionApprove,
        startDate: "2027-01-05",
      },
    );
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitReject),
      {
        categoryCode: "unpaid",
        endDate: "2027-01-06",
        idempotencyKey: "demotion-reject",
        leaveRequestId: ids.requestDemotionReject,
        startDate: "2027-01-06",
      },
    );
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitReplayApprove),
      {
        categoryCode: "sick",
        endDate: "2027-01-07",
        idempotencyKey: "demotion-replay-approve",
        leaveRequestId: ids.requestDemotionReplayApprove,
        startDate: "2027-01-07",
      },
    );
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitReplayReject),
      {
        categoryCode: "other",
        endDate: "2027-01-08",
        idempotencyKey: "demotion-replay-reject",
        leaveRequestId: ids.requestDemotionReplayReject,
        startDate: "2027-01-08",
      },
    );

    expect(
      await getLeaveRequest(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
        ids.requestDemotionView,
      ),
    ).toMatchObject({ leaveRequestId: ids.requestDemotionView, status: "submitted", version: 1 });
    expect(
      await getLeaveRequestDetail(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
        ids.requestDemotionView,
      ),
    ).toMatchObject({
      history: [expect.objectContaining({ newState: "submitted" })],
      request: { leaveRequestId: ids.requestDemotionView, status: "submitted", version: 1 },
    });
    expect(
      await listLeaveEvidence(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
        ids.requestDemotionView,
      ),
    ).toEqual([expect.objectContaining({ newState: "submitted" })]);
    expect(
      (
        await listAssignedLeaveRequests(
          pool,
          context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
        )
      ).some((request) => request.leaveRequestId === ids.requestDemotionView),
    ).toBe(true);

    const approved = await approveLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationDemotionApprove),
      { expectedVersion: 1, leaveRequestId: ids.requestDemotionReplayApprove },
    );
    expect(approved).toMatchObject({
      replayed: false,
      request: { status: "approved", version: 2 },
    });
    const approvedReplay = await approveLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationDemotionApprove),
      { expectedVersion: 1, leaveRequestId: ids.requestDemotionReplayApprove },
    );
    expect(approvedReplay).toMatchObject({
      replayed: true,
      request: { status: "approved", version: 2 },
    });

    const rejectionInput = {
      decisionNote: "Exact replay remains unauthorized after demotion.",
      expectedVersion: 1,
      leaveRequestId: ids.requestDemotionReplayReject,
    } as const;
    const rejected = await rejectLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationDemotionReject),
      rejectionInput,
    );
    expect(rejected).toMatchObject({
      replayed: false,
      request: { status: "rejected", version: 2 },
    });
    const rejectedReplay = await rejectLeaveRequest(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationDemotionReject),
      rejectionInput,
    );
    expect(rejectedReplay).toMatchObject({
      replayed: true,
      request: { status: "rejected", version: 2 },
    });

    const baseline = await snapshotLeavePersistence(leaveRequestIds);
    expect(baseline.requests).toHaveLength(5);
    expect(baseline.work).toHaveLength(5);
    expect(baseline.evidence).toHaveLength(7);
    expect(baseline.outbox).toHaveLength(7);
    expect(baseline.requests.map((request) => request.status).sort()).toEqual([
      "approved",
      "rejected",
      "submitted",
      "submitted",
      "submitted",
    ]);
    expect(baseline.work.map((workItem) => workItem.status).sort()).toEqual([
      "completed",
      "completed",
      "open",
      "open",
      "open",
    ]);
    for (const leaveRequestId of [
      ids.requestDemotionView,
      ids.requestDemotionApprove,
      ids.requestDemotionReject,
    ]) {
      expect(
        baseline.requests.find((request) => request.leave_request_id === leaveRequestId),
      ).toMatchObject({
        approver_principal_id: ids.managerA,
        decided_at: null,
        decision_note: null,
        status: "submitted",
        version: 1,
      });
      expect(
        baseline.work.find((workItem) => workItem.subject_id === leaveRequestId),
      ).toMatchObject({
        assignee_principal_id: ids.managerA,
        completed_at: null,
        status: "open",
      });
    }
    expect(
      baseline.requests.find(
        (request) => request.leave_request_id === ids.requestDemotionReplayApprove,
      ),
    ).toMatchObject({ decided_at: expect.any(String), status: "approved", version: 2 });
    expect(
      baseline.requests.find(
        (request) => request.leave_request_id === ids.requestDemotionReplayReject,
      ),
    ).toMatchObject({
      decided_at: expect.any(String),
      decision_note: rejectionInput.decisionNote,
      status: "rejected",
      version: 2,
    });
    for (const leaveRequestId of [
      ids.requestDemotionReplayApprove,
      ids.requestDemotionReplayReject,
    ]) {
      expect(
        baseline.work.find((workItem) => workItem.subject_id === leaveRequestId),
      ).toMatchObject({
        assignee_principal_id: ids.managerA,
        completed_at: expect.any(String),
        status: "completed",
      });
    }

    try {
      for (const roleKey of ["employee", "tenant_admin", "leave_auditor"] as const) {
        await setManagerAState(roleKey, "active");

        await expect(
          getLeaveRequest(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
        await expect(
          getLeaveRequestDetail(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
        await expect(
          listLeaveEvidence(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });
        await expect(
          listAssignedLeaveRequests(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
          ),
        ).rejects.toMatchObject({ code: "POLICY_DENIED" });

        await expectDeniedWithoutPersistenceChange(
          async () =>
            await approveLeaveRequest(
              pool,
              context(ids.tenantA, ids.managerA, ids.correlationDemotionApprove),
              { expectedVersion: 1, leaveRequestId: ids.requestDemotionApprove },
            ),
          "POLICY_DENIED",
          leaveRequestIds,
          baseline,
        );
        await expectDeniedWithoutPersistenceChange(
          async () =>
            await rejectLeaveRequest(
              pool,
              context(ids.tenantA, ids.managerA, ids.correlationDemotionReject),
              {
                decisionNote: "A valid note must not bypass current-role authorization.",
                expectedVersion: 1,
                leaveRequestId: ids.requestDemotionReject,
              },
            ),
          "POLICY_DENIED",
          leaveRequestIds,
          baseline,
        );

        if (roleKey === "employee") {
          expect(
            await getLeaveRequest(
              pool,
              context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitView),
              ids.requestDemotionView,
            ),
          ).toMatchObject({
            employeePrincipalId: ids.employeeA2,
            leaveRequestId: ids.requestDemotionView,
            status: "submitted",
          });
          expect(
            await getLeaveRequestDetail(
              pool,
              context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitView),
              ids.requestDemotionView,
            ),
          ).toMatchObject({
            history: [expect.objectContaining({ newState: "submitted" })],
            request: { leaveRequestId: ids.requestDemotionView },
          });
          expect(
            await listLeaveEvidence(
              pool,
              context(ids.tenantA, ids.employeeA2, ids.correlationDemotionSubmitView),
              ids.requestDemotionView,
            ),
          ).toEqual([expect.objectContaining({ newState: "submitted" })]);

          await expectDeniedWithoutPersistenceChange(
            async () =>
              await approveLeaveRequest(
                pool,
                context(ids.tenantA, ids.managerA, ids.correlationDemotionApprove),
                { expectedVersion: 1, leaveRequestId: ids.requestDemotionReplayApprove },
              ),
            "POLICY_DENIED",
            leaveRequestIds,
            baseline,
          );
          await expectDeniedWithoutPersistenceChange(
            async () =>
              await rejectLeaveRequest(
                pool,
                context(ids.tenantA, ids.managerA, ids.correlationDemotionReject),
                rejectionInput,
              ),
            "POLICY_DENIED",
            leaveRequestIds,
            baseline,
          );
        }
      }

      await setManagerAState("manager", "suspended");
      for (const operation of [
        async () =>
          await getLeaveRequest(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        async () =>
          await getLeaveRequestDetail(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        async () =>
          await listLeaveEvidence(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
            ids.requestDemotionView,
          ),
        async () =>
          await listAssignedLeaveRequests(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionSubmitView),
          ),
      ]) {
        await expect(operation()).rejects.toMatchObject({ code: "ACTOR_NOT_ACTIVE_MEMBER" });
      }
      await expectDeniedWithoutPersistenceChange(
        async () =>
          await approveLeaveRequest(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionApprove),
            { expectedVersion: 1, leaveRequestId: ids.requestDemotionApprove },
          ),
        "ACTOR_NOT_ACTIVE_MEMBER",
        leaveRequestIds,
        baseline,
      );
      await expectDeniedWithoutPersistenceChange(
        async () =>
          await rejectLeaveRequest(
            pool,
            context(ids.tenantA, ids.managerA, ids.correlationDemotionReject),
            {
              decisionNote: "Suspension must fail before the decision path.",
              expectedVersion: 1,
              leaveRequestId: ids.requestDemotionReject,
            },
          ),
        "ACTOR_NOT_ACTIVE_MEMBER",
        leaveRequestIds,
        baseline,
      );
    } finally {
      await setManagerAState("manager", "active");
    }
  });

  it("serializes current-role reads with committed membership demotion", async () => {
    const demotionClient = await pool.connect();
    const observer = await pool.connect();
    let actorOperation: Promise<boolean> | undefined;
    let blockedAssignedList: Promise<readonly unknown[]> | undefined;
    let demotionTransaction = false;
    let releaseActorLock: (() => void) | undefined;

    try {
      const demotionPid = Number(
        (await demotionClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid,
      );
      let signalActorLock: ((pid: number) => void) | undefined;
      const actorLockAcquired = new Promise<number>((resolve) => {
        signalActorLock = resolve;
      });
      const holdActorLock = new Promise<void>((resolve) => {
        releaseActorLock = resolve;
      });

      actorOperation = withTenantTransaction(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDemotionUpdate),
        async ({ actor, client }) => {
          const actorPid = Number(
            (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
          );
          signalActorLock?.(actorPid);
          await holdActorLock;
          return actor.roleKey === "manager";
        },
      );
      const actorPid = await actorLockAcquired;

      await demotionClient.query("BEGIN");
      demotionTransaction = true;
      await demotionClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      const blockedDemotion = demotionClient.query(
        `UPDATE memberships
         SET role_key = 'employee'
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.managerA],
      );
      await expectBackendBlockedBy(observer, demotionPid, actorPid);

      releaseActorLock?.();
      releaseActorLock = undefined;
      expect(await actorOperation).toBe(true);
      actorOperation = undefined;
      expect((await blockedDemotion).rowCount).toBe(1);
      await demotionClient.query("COMMIT");
      demotionTransaction = false;
      await setManagerAState("manager", "active");

      await demotionClient.query("BEGIN");
      demotionTransaction = true;
      await demotionClient.query("SELECT set_config('app.tenant_id', $1, true)", [ids.tenantA]);
      await demotionClient.query(
        `UPDATE memberships
         SET role_key = 'employee'
         WHERE tenant_id = $1 AND principal_id = $2`,
        [ids.tenantA, ids.managerA],
      );

      blockedAssignedList = listAssignedLeaveRequests(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDemotionUpdate),
      );
      expect(await expectAnyBackendBlockedBy(observer, demotionPid)).toBeGreaterThan(0);

      await demotionClient.query("COMMIT");
      demotionTransaction = false;
      await expect(blockedAssignedList).rejects.toMatchObject({ code: "POLICY_DENIED" });
      blockedAssignedList = undefined;
    } finally {
      releaseActorLock?.();
      if (actorOperation) await Promise.allSettled([actorOperation]);
      if (demotionTransaction) await demotionClient.query("ROLLBACK");
      if (blockedAssignedList) await Promise.allSettled([blockedAssignedList]);
      demotionClient.release();
      observer.release();
      await setManagerAState("manager", "active");
    }
  }, 15_000);

  it("keeps a detail-first approval snapshot coherent behind the exact detail backend", async () => {
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDetailFirstSubmit),
      {
        categoryCode: "annual",
        endDate: "2027-02-01",
        idempotencyKey: "detail-first-approval",
        leaveRequestId: ids.requestDetailFirstApprove,
        startDate: "2027-02-01",
      },
    );

    const detailControl = createControlledPool(pool, (statement, values) =>
      matchesLeaveSelector(statement, values, ids.requestDetailFirstApprove, "detail"),
    );
    const decisionControl = createControlledPool(pool);
    const observer = await pool.connect();
    let detailOperation: ReturnType<typeof getLeaveRequestDetail> | undefined;
    let decisionOperation: ReturnType<typeof approveLeaveRequest> | undefined;

    try {
      const observerPid = Number(
        (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      detailOperation = getLeaveRequestDetail(
        detailControl.pool,
        context(ids.tenantA, ids.employeeA2, ids.correlationDetailFirstRead),
        ids.requestDetailFirstApprove,
      );
      const detailPid = (
        await awaitControlledSignal(
          "detail-first detail selector",
          detailControl.paused,
          detailOperation,
        )
      ).pid;

      decisionOperation = approveLeaveRequest(
        decisionControl.pool,
        context(ids.tenantA, ids.managerA, ids.correlationDetailFirstApprove),
        { expectedVersion: 1, leaveRequestId: ids.requestDetailFirstApprove },
      );
      const decisionPid = await awaitControlledSignal(
        "detail-first approval connection",
        decisionControl.connected,
        decisionOperation,
      );
      let decisionSettled = false;
      void decisionOperation.then(
        () => {
          decisionSettled = true;
        },
        () => {
          decisionSettled = true;
        },
      );
      expect(new Set([detailPid, decisionPid, observerPid]).size).toBe(3);

      const directBlocker = await observeDirectBlockerUntil(
        observer,
        decisionPid,
        detailPid,
        () => decisionSettled,
      );
      detailControl.release();
      const detail = await detailOperation;
      detailOperation = undefined;

      expect({
        directBlocker,
        employeeDisplayName: detail?.request.employeeDisplayName,
        lastHistoryState: detail?.history.at(-1)?.newState,
        requestStatus: detail?.request.status,
      }).toEqual({
        directBlocker: true,
        employeeDisplayName: "Employee A2",
        lastHistoryState: "submitted",
        requestStatus: "submitted",
      });

      const decision = await decisionOperation;
      decisionOperation = undefined;
      expect(decision).toMatchObject({
        replayed: false,
        request: { status: "approved", version: 2 },
      });
      const terminalDetail = await getLeaveRequestDetail(
        pool,
        context(ids.tenantA, ids.employeeA2, ids.correlationDetailFirstRead),
        ids.requestDetailFirstApprove,
      );
      expect(terminalDetail).toMatchObject({
        history: [
          expect.objectContaining({ newState: "submitted" }),
          expect.objectContaining({ newState: "approved" }),
        ],
        request: { employeeDisplayName: "Employee A2", status: "approved", version: 2 },
      });
      const persistence = await snapshotLeavePersistence([ids.requestDetailFirstApprove]);
      expect(persistence.requests).toEqual([
        expect.objectContaining({ status: "approved", version: 2 }),
      ]);
      expect(persistence.work).toEqual([expect.objectContaining({ status: "completed" })]);
      expect(persistence.evidence).toHaveLength(2);
      expect(persistence.outbox).toHaveLength(2);
    } finally {
      detailControl.release();
      decisionControl.release();
      const pendingOperations: Promise<unknown>[] = [];
      if (detailOperation) pendingOperations.push(detailOperation);
      if (decisionOperation) pendingOperations.push(decisionOperation);
      await Promise.allSettled(pendingOperations);
      observer.release();
    }
  }, 15_000);

  it("keeps a decision-first rejection snapshot coherent behind the exact decision backend", async () => {
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDecisionFirstSubmit),
      {
        categoryCode: "unpaid",
        endDate: "2027-02-02",
        idempotencyKey: "decision-first-rejection",
        leaveRequestId: ids.requestDecisionFirstReject,
        startDate: "2027-02-02",
      },
    );

    const decisionControl = createControlledPool(pool, (statement, values) =>
      matchesLeaveSelector(statement, values, ids.requestDecisionFirstReject, "update"),
    );
    const detailControl = createControlledPool(pool, (statement, values) =>
      matchesLeaveSelector(statement, values, ids.requestDecisionFirstReject, "detail"),
    );
    const observer = await pool.connect();
    let decisionOperation: ReturnType<typeof rejectLeaveRequest> | undefined;
    let detailOperation: ReturnType<typeof getLeaveRequestDetail> | undefined;

    try {
      const observerPid = Number(
        (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
      );
      decisionOperation = rejectLeaveRequest(
        decisionControl.pool,
        context(ids.tenantA, ids.managerA, ids.correlationDecisionFirstReject),
        {
          decisionNote: "Coverage is unavailable for this date.",
          expectedVersion: 1,
          leaveRequestId: ids.requestDecisionFirstReject,
        },
      );
      const decisionPid = (
        await awaitControlledSignal(
          "decision-first rejection selector",
          decisionControl.paused,
          decisionOperation,
        )
      ).pid;

      detailOperation = getLeaveRequestDetail(
        detailControl.pool,
        context(ids.tenantA, ids.employeeA2, ids.correlationDecisionFirstRead),
        ids.requestDecisionFirstReject,
      );
      const detailPid = await awaitControlledSignal(
        "decision-first detail connection",
        detailControl.connected,
        detailOperation,
      );
      expect(new Set([detailPid, decisionPid, observerPid]).size).toBe(3);

      const directBlocker = await observeDirectBlockerUntil(
        observer,
        detailPid,
        decisionPid,
        detailControl.isPaused,
      );
      decisionControl.release();
      const decision = await decisionOperation;
      decisionOperation = undefined;
      expect(decision).toMatchObject({
        replayed: false,
        request: { status: "rejected", version: 2 },
      });

      await awaitControlledSignal(
        "decision-first detail selector",
        detailControl.paused,
        detailOperation,
      );
      const beforeDetailCompletion = await snapshotLeavePersistence([
        ids.requestDecisionFirstReject,
      ]);
      detailControl.release();
      const detail = await detailOperation;
      detailOperation = undefined;
      const afterDetailCompletion = await snapshotLeavePersistence([
        ids.requestDecisionFirstReject,
      ]);

      expect(afterDetailCompletion).toEqual(beforeDetailCompletion);
      expect({
        directBlocker,
        employeeDisplayName: detail?.request.employeeDisplayName,
        lastHistoryState: detail?.history.at(-1)?.newState,
        requestStatus: detail?.request.status,
      }).toEqual({
        directBlocker: true,
        employeeDisplayName: "Employee A2",
        lastHistoryState: "rejected",
        requestStatus: "rejected",
      });
      expect(afterDetailCompletion.requests).toEqual([
        expect.objectContaining({ status: "rejected", version: 2 }),
      ]);
      expect(afterDetailCompletion.work).toEqual([
        expect.objectContaining({ status: "completed" }),
      ]);
      expect(afterDetailCompletion.evidence).toHaveLength(2);
      expect(afterDetailCompletion.outbox).toHaveLength(2);
    } finally {
      decisionControl.release();
      detailControl.release();
      const pendingOperations: Promise<unknown>[] = [];
      if (decisionOperation) pendingOperations.push(decisionOperation);
      if (detailOperation) pendingOperations.push(detailOperation);
      await Promise.allSettled(pendingOperations);
      observer.release();
    }
  }, 15_000);

  it("keeps tenant reads isolated and query pages bounded", async () => {
    await submitLeaveRequest(pool, context(ids.tenantB, ids.employeeB, ids.correlationSubmitB), {
      categoryCode: "unpaid",
      endDate: "2026-10-10",
      idempotencyKey: "tenant-b-request",
      leaveRequestId: ids.requestB,
      startDate: "2026-10-10",
    });
    expect(
      await getLeaveRequest(
        pool,
        context(ids.tenantB, ids.employeeB, ids.correlationSubmitB),
        ids.request1,
      ),
    ).toBeNull();
    expect(
      await getLeaveRequestDetail(
        pool,
        context(ids.tenantB, ids.employeeB, ids.correlationSubmitB),
        ids.request1,
      ),
    ).toBeNull();
    expect(
      await getLeaveRequestDetail(
        pool,
        context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
        ids.requestMissing,
      ),
    ).toBeNull();
    const ownB = await listOwnLeaveRequests(
      pool,
      context(ids.tenantB, ids.employeeB, ids.correlationSubmitB),
    );
    expect(ownB.map((request) => request.leaveRequestId)).toEqual([ids.requestB]);
    await expect(
      listOwnLeaveRequests(pool, context(ids.tenantB, ids.employeeB, ids.correlationSubmitB), {
        pageSize: 51,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_INPUT_INVALID" });
    await expect(
      listAssignedLeaveRequests(pool, context(ids.tenantA, ids.employeeA, ids.correlationSubmit1)),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    const firstOwnPage = await listOwnLeaveRequests(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
      { pageSize: 1 },
    );
    const firstOwn = firstOwnPage[0];
    expect(firstOwn).toBeDefined();
    const nextOwnPage = await listOwnLeaveRequests(
      pool,
      context(ids.tenantA, ids.employeeA, ids.correlationSubmit1),
      {
        cursor: {
          leaveRequestId: firstOwn?.leaveRequestId ?? "",
          submittedAt: firstOwn?.submittedAt ?? "",
        },
        pageSize: 1,
      },
    );
    expect(nextOwnPage[0]?.leaveRequestId).not.toBe(firstOwn?.leaveRequestId);
  });

  it("serializes competing manager decisions with one terminal winner", async () => {
    await submitLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDecisionApprove),
      {
        categoryCode: "annual",
        endDate: "2026-12-02",
        idempotencyKey: "competing-decision",
        leaveRequestId: ids.requestDecision,
        startDate: "2026-12-01",
      },
    );
    const decisions = await Promise.allSettled([
      approveLeaveRequest(
        pool,
        context(ids.tenantA, ids.managerA, ids.correlationDecisionApprove),
        { expectedVersion: 1, leaveRequestId: ids.requestDecision },
      ),
      rejectLeaveRequest(pool, context(ids.tenantA, ids.managerA, ids.correlationDecisionReject), {
        decisionNote: "Concurrent rejection path",
        expectedVersion: 1,
        leaveRequestId: ids.requestDecision,
      }),
    ]);
    expect(decisions.filter((decision) => decision.status === "fulfilled")).toHaveLength(1);
    expect(decisions.filter((decision) => decision.status === "rejected")).toHaveLength(1);
    const request = await getLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDecisionApprove),
      ids.requestDecision,
    );
    expect(["approved", "rejected"]).toContain(request?.status);
    expect(request?.version).toBe(2);
    const evidence = await listLeaveEvidence(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationDecisionApprove),
      ids.requestDecision,
    );
    expect(evidence).toHaveLength(2);
  });

  it("rolls back a decision when its work-item dependency is missing", async () => {
    await submitLeaveRequest(pool, context(ids.tenantA, ids.employeeA2, ids.correlationSubmit3), {
      categoryCode: "other",
      endDate: "2026-11-12",
      idempotencyKey: "rollback-request",
      leaveRequestId: ids.request3,
      startDate: "2026-11-12",
    });
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.adminA, ids.correlationRollback),
      async ({ client }) => {
        await client.query("DELETE FROM work_items WHERE subject_id = $1", [ids.request3]);
      },
    );
    await expect(
      approveLeaveRequest(pool, context(ids.tenantA, ids.managerA, ids.correlationRollback), {
        expectedVersion: 1,
        leaveRequestId: ids.request3,
      }),
    ).rejects.toMatchObject({ code: "LEAVE_STATE_CONFLICT" });
    const request = await getLeaveRequest(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationSubmit3),
      ids.request3,
    );
    expect(request).toMatchObject({ status: "submitted", version: 1 });
    const evidence = await listLeaveEvidence(
      pool,
      context(ids.tenantA, ids.employeeA2, ids.correlationSubmit3),
      ids.request3,
    );
    expect(evidence.map((event) => event.newState)).toEqual(["submitted"]);
  });

  it("uses the declared indexes and fails closed after service deactivation", async () => {
    await withTenantTransaction(
      pool,
      context(ids.tenantA, ids.managerA, ids.correlationApproveRetry),
      async ({ client }) => {
        await client.query("SET LOCAL enable_seqscan = off");
        const assigned = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT request.leave_request_id
           FROM hr_leave_requests request
           JOIN work_items work
             ON work.tenant_id = request.tenant_id
            AND work.subject_id = request.leave_request_id
           JOIN principals principal
             ON principal.principal_id = request.employee_principal_id
           WHERE request.tenant_id = $1
             AND request.approver_principal_id = $2
             AND request.status = 'submitted'
             AND work.assignee_principal_id = $2
             AND work.work_type = 'hr.leave_request.approval'
             AND work.subject_type = 'hr.leave_request'
             AND work.status = 'open'
           ORDER BY request.submitted_at ASC, request.leave_request_id ASC
           LIMIT 50`,
          [ids.tenantA, ids.managerA],
        );
        const own = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT leave_request_id FROM hr_leave_requests
           WHERE tenant_id = $1 AND employee_principal_id = $2
           ORDER BY submitted_at DESC, leave_request_id DESC LIMIT 50`,
          [ids.tenantA, ids.employeeA],
        );
        const evidence = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT evidence_event_id FROM evidence_events
           WHERE tenant_id = $1 AND subject_type = 'hr.leave_request' AND subject_id = $2
           ORDER BY occurred_at ASC, evidence_event_id ASC LIMIT 100`,
          [ids.tenantA, ids.request1],
        );
        const employeeName = await client.query<{ "QUERY PLAN": string }>(
          `EXPLAIN (COSTS OFF)
           SELECT principal.display_name
           FROM memberships membership
           JOIN principals principal ON principal.principal_id = membership.principal_id
           WHERE membership.tenant_id = $1 AND membership.principal_id = $2`,
          [ids.tenantA, ids.employeeA],
        );
        const plans = [...assigned.rows, ...own.rows, ...evidence.rows, ...employeeName.rows]
          .map((row) => row["QUERY PLAN"])
          .join("\n");
        expect(plans).toContain("hr_leave_requests_assigned_open_idx");
        expect(plans).toContain("work_items_tenant_work_subject_uq");
        expect(plans).toContain("hr_leave_requests_employee_history_idx");
        expect(plans).toContain("evidence_events_tenant_subject_occurred_idx");
        expect(plans).toContain("memberships_tenant_principal_uq");
      },
    );

    await withTenantTransaction(
      pool,
      context(ids.tenantB, ids.adminB, ids.correlationDeactivateB),
      async (transaction) => {
        const authorization = evaluatePolicy(
          {
            actionKey: "platform.service_activation.deactivate",
            input: { serviceKey: "hr.leave_request" },
            resourceKey: "hr.leave_request",
            transaction,
          },
          [
            {
              effect: "allow",
              id: "tenant_admin_deactivate_service",
              matches: (_input, actor) => actor.roleKey === "tenant_admin",
            },
          ],
        );
        await setServiceActivation(transaction, {
          authorization,
          evidenceEventType: "evidence.hr.leave_service.deactivated",
          expectedVersion: 1,
          outboxEventType: "hr.leave_service.deactivated",
          serviceKey: "hr.leave_request",
          targetState: "inactive",
        });
      },
    );
    await expect(
      listOwnLeaveRequests(pool, context(ids.tenantB, ids.employeeB, ids.correlationDeactivateB)),
    ).rejects.toMatchObject({ code: "LEAVE_SERVICE_INACTIVE" });
    await expect(
      getLeaveRequestDetail(
        pool,
        context(ids.tenantB, ids.employeeB, ids.correlationDeactivateB),
        ids.requestB,
      ),
    ).rejects.toMatchObject({ code: "LEAVE_SERVICE_INACTIVE" });
  });
});
