import type { Pool } from "pg";
import { HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES } from "./shift-assignment-readiness.js";

export async function observeShiftServiceLockContention(
  migrationPool: Pool,
  tenantId: string,
  operation: () => Promise<unknown>,
): Promise<{ bounded: string; settled: string }> {
  const blocker = await migrationPool.connect();
  let blockerOpen = false;
  try {
    await blocker.query("BEGIN");
    blockerOpen = true;
    await blocker.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await blocker.query(
      `SELECT service_key FROM service_activations
       WHERE tenant_id=$1 AND service_key='workforce_profile' FOR UPDATE`,
      [tenantId],
    );
    const attempt = operation().then(
      () => "fulfilled",
      (error: unknown) => String((error as { code?: unknown }).code),
    );
    const bounded = await Promise.race([
      attempt,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 1_000)),
    ]);
    await blocker.query("ROLLBACK");
    blockerOpen = false;
    return { bounded, settled: await attempt };
  } finally {
    if (blockerOpen) await blocker.query("ROLLBACK");
    blocker.release();
  }
}

export async function restoreShiftRuntimeTableAuthority(
  migrationPool: Pool,
  applicationRole: string,
): Promise<void> {
  for (const required of HR_SHIFT_ASSIGNMENT_RUNTIME_TABLE_PRIVILEGES) {
    if (!/^public\.[a-z_][a-z0-9_]*$/.test(required.name)) {
      throw new Error("Shift Runtime authority contains an unsafe table identity");
    }
    const columns = await migrationPool.query<{ value: string | null }>(
      `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) value
       FROM pg_attribute
       WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped`,
      [required.name],
    );
    const columnList = columns.rows[0]?.value;
    if (!columnList) throw new Error("Shift Runtime table columns are unavailable");

    await migrationPool.query(
      `REVOKE ALL PRIVILEGES ON TABLE ${required.name} FROM ${applicationRole}`,
    );
    await migrationPool.query(
      `REVOKE SELECT (${columnList}), INSERT (${columnList}), UPDATE (${columnList}),
              REFERENCES (${columnList}) ON ${required.name} FROM ${applicationRole}`,
    );
    const grants = Object.entries(required)
      .filter(([key, granted]) => key !== "name" && granted)
      .map(([key]) => key.toUpperCase());
    if (grants.length > 0) {
      await migrationPool.query(
        `GRANT ${grants.join(", ")} ON TABLE ${required.name} TO ${applicationRole}`,
      );
    }
  }
}
