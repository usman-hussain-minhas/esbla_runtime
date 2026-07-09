import { createHash } from "node:crypto";
import type { TenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";

export interface EvidenceInput {
  readonly eventType: string;
  readonly newState: string;
  readonly priorState: string | null;
  readonly subjectId: string;
  readonly subjectType: string;
}

export interface OutboxInput {
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface MutationProofInput {
  readonly evidence: EvidenceInput;
  readonly outbox: OutboxInput;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeJsonPayload(value: Readonly<Record<string, unknown>>): {
  canonical: string;
  serialized: string;
} {
  try {
    const serialized = JSON.stringify(value);
    const normalized: unknown = JSON.parse(serialized);
    return { canonical: canonicalJson(normalized), serialized };
  } catch {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Outbox payload is not valid JSON");
  }
}

export function deriveStableUuid(namespace: string, ...parts: readonly string[]): string {
  const bytes = createHash("sha256")
    .update([namespace, ...parts].join("\u001f"))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function appendEvidence(
  transaction: TenantTransaction,
  input: EvidenceInput,
): Promise<{ evidenceEventId: string; replayed: boolean }> {
  const inserted = await transaction.client.query<{ evidence_event_id: string }>(
    `INSERT INTO evidence_events
       (tenant_id, event_type, subject_type, subject_id, actor_principal_id,
        correlation_id, prior_state, new_state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, subject_type, subject_id, event_type, correlation_id)
     DO NOTHING
     RETURNING evidence_event_id`,
    [
      transaction.context.tenantId,
      input.eventType,
      input.subjectType,
      input.subjectId,
      transaction.context.actorPrincipalId,
      transaction.context.correlationId,
      input.priorState,
      input.newState,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { evidenceEventId: created.evidence_event_id, replayed: false };

  const existing = await transaction.client.query<{
    actor_principal_id: string;
    evidence_event_id: string;
    new_state: string;
    prior_state: string | null;
  }>(
    `SELECT evidence_event_id, actor_principal_id, prior_state, new_state
     FROM evidence_events
     WHERE tenant_id = $1 AND subject_type = $2 AND subject_id = $3
       AND event_type = $4 AND correlation_id = $5`,
    [
      transaction.context.tenantId,
      input.subjectType,
      input.subjectId,
      input.eventType,
      transaction.context.correlationId,
    ],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.actor_principal_id !== transaction.context.actorPrincipalId ||
    row.prior_state !== input.priorState ||
    row.new_state !== input.newState
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Evidence retry changed its semantics", {
      eventType: input.eventType,
      subjectId: input.subjectId,
    });
  }
  return { evidenceEventId: row.evidence_event_id, replayed: true };
}

export async function appendOutboxEvent(
  transaction: TenantTransaction,
  input: OutboxInput,
): Promise<{ eventId: string; replayed: boolean }> {
  const normalizedPayload = normalizeJsonPayload(input.payload);
  const inserted = await transaction.client.query<{ event_id: string }>(
    `INSERT INTO outbox_events
       (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version,
        correlation_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (tenant_id, event_type, aggregate_type, aggregate_id, aggregate_version)
     DO NOTHING
     RETURNING event_id`,
    [
      transaction.context.tenantId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
      transaction.context.correlationId,
      normalizedPayload.serialized,
    ],
  );
  const created = inserted.rows[0];
  if (created) return { eventId: created.event_id, replayed: false };

  const existing = await transaction.client.query<{
    correlation_id: string;
    event_id: string;
    payload: unknown;
  }>(
    `SELECT event_id, correlation_id, payload
     FROM outbox_events
     WHERE tenant_id = $1 AND event_type = $2 AND aggregate_type = $3
       AND aggregate_id = $4 AND aggregate_version = $5`,
    [
      transaction.context.tenantId,
      input.eventType,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
    ],
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.correlation_id !== transaction.context.correlationId ||
    canonicalJson(row.payload) !== normalizedPayload.canonical
  ) {
    throw new PlatformError("IDEMPOTENCY_CONFLICT", "Outbox retry changed its payload", {
      aggregateId: input.aggregateId,
      eventType: input.eventType,
    });
  }
  return { eventId: row.event_id, replayed: true };
}

export async function recordMutationProof(
  transaction: TenantTransaction,
  input: MutationProofInput,
): Promise<{ evidenceEventId: string; outboxEventId: string; replayed: boolean }> {
  const evidence = await appendEvidence(transaction, input.evidence);
  const outbox = await appendOutboxEvent(transaction, input.outbox);
  return {
    evidenceEventId: evidence.evidenceEventId,
    outboxEventId: outbox.eventId,
    replayed: evidence.replayed && outbox.replayed,
  };
}
