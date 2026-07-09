import type { TenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";
import { assertPolicyAllowed, type PolicyDecision } from "./policy.js";
import { deriveStableUuid, recordMutationProof } from "./proof.js";

export type ServiceActivationState = "active" | "inactive";

export interface ActivationPreflight {
  readonly current: boolean;
  readonly reasons: readonly string[];
}

export interface SetServiceActivationInput {
  readonly authorization: PolicyDecision;
  readonly evidenceEventType: string;
  readonly expectedVersion: number | null;
  readonly outboxEventType: string;
  readonly preflight?: () => Promise<ActivationPreflight>;
  readonly serviceKey: string;
  readonly targetState: ServiceActivationState;
}

export interface ServiceActivationResult {
  readonly replayed: boolean;
  readonly serviceKey: string;
  readonly state: ServiceActivationState;
  readonly version: number;
}

export async function getServiceActivation(
  transaction: TenantTransaction,
  serviceKey: string,
): Promise<ServiceActivationResult | null> {
  const result = await transaction.client.query<{
    service_key: string;
    state: ServiceActivationState;
    version: number;
  }>(
    `SELECT service_key, state, version
     FROM service_activations
     WHERE tenant_id = $1 AND service_key = $2`,
    [transaction.context.tenantId, serviceKey],
  );
  const row = result.rows[0];
  return row
    ? { replayed: false, serviceKey: row.service_key, state: row.state, version: row.version }
    : null;
}

export async function setServiceActivation(
  transaction: TenantTransaction,
  input: SetServiceActivationInput,
): Promise<ServiceActivationResult> {
  assertPolicyAllowed(
    input.authorization,
    transaction,
    `platform.service_activation.${input.targetState === "active" ? "activate" : "deactivate"}`,
    input.serviceKey,
  );
  const subjectId = deriveStableUuid(
    "platform.service_activation",
    transaction.context.tenantId,
    input.serviceKey,
  );
  const replay = await transaction.client.query<{ state: ServiceActivationState; version: number }>(
    `SELECT e.new_state AS state, o.aggregate_version AS version
     FROM evidence_events e
     JOIN outbox_events o
       ON o.tenant_id = e.tenant_id
      AND o.aggregate_type = e.subject_type
      AND o.aggregate_id = e.subject_id
      AND o.correlation_id = e.correlation_id
     WHERE e.tenant_id = $1 AND e.subject_type = 'platform.service_activation'
       AND e.subject_id = $2 AND e.event_type = $3 AND e.correlation_id = $4
       AND e.new_state = $5 AND e.actor_principal_id = $6 AND o.event_type = $7`,
    [
      transaction.context.tenantId,
      subjectId,
      input.evidenceEventType,
      transaction.context.correlationId,
      input.targetState,
      transaction.context.actorPrincipalId,
      input.outboxEventType,
    ],
  );
  if (replay.rows[0]) {
    return {
      replayed: true,
      serviceKey: input.serviceKey,
      state: replay.rows[0].state,
      version: replay.rows[0].version,
    };
  }

  if (input.targetState === "active") {
    const preflight = input.preflight ? await input.preflight() : null;
    if (!preflight?.current) {
      throw new PlatformError(
        "ACTIVATION_DEPENDENCY_BLOCKED",
        "Service activation dependencies are not current",
        { reasons: preflight?.reasons ?? ["missing_activation_preflight"] },
      );
    }
  }

  const current = await transaction.client.query<{
    state: ServiceActivationState;
    version: number;
  }>(
    `SELECT state, version
     FROM service_activations
     WHERE tenant_id = $1 AND service_key = $2
     FOR UPDATE`,
    [transaction.context.tenantId, input.serviceKey],
  );
  const row = current.rows[0];
  if (
    (!row && input.targetState === "inactive") ||
    (row?.version ?? null) !== input.expectedVersion ||
    row?.state === input.targetState
  ) {
    throw new PlatformError("ACTIVATION_CONFLICT", "Service activation currentness check failed", {
      actualState: row?.state ?? null,
      actualVersion: row?.version ?? null,
      expectedVersion: input.expectedVersion,
      targetState: input.targetState,
    });
  }

  const version = row ? row.version + 1 : 1;
  if (row) {
    await transaction.client.query(
      `UPDATE service_activations
       SET state = $3, version = $4
       WHERE tenant_id = $1 AND service_key = $2`,
      [transaction.context.tenantId, input.serviceKey, input.targetState, version],
    );
  } else {
    await transaction.client.query(
      `INSERT INTO service_activations (tenant_id, service_key, state, version)
       VALUES ($1, $2, $3, $4)`,
      [transaction.context.tenantId, input.serviceKey, input.targetState, version],
    );
  }

  await recordMutationProof(transaction, {
    evidence: {
      eventType: input.evidenceEventType,
      newState: input.targetState,
      priorState: row?.state ?? null,
      subjectId,
      subjectType: "platform.service_activation",
    },
    outbox: {
      aggregateId: subjectId,
      aggregateType: "platform.service_activation",
      aggregateVersion: version,
      eventType: input.outboxEventType,
      payload: { serviceKey: input.serviceKey, state: input.targetState, version },
    },
  });

  return { replayed: false, serviceKey: input.serviceKey, state: input.targetState, version };
}
