const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const datePattern = "^\\d{4}-\\d{2}-\\d{2}$";
const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface WorkspaceCreateTaskBody {
  readonly assigneePrincipalId: string;
  readonly description?: string | null;
  readonly dueOn?: string | null;
  readonly title: string;
}

export interface WorkspaceCompleteTaskBody {
  readonly completionNote?: string | null;
  readonly expectedVersion: number;
}

export interface WorkspaceTaskPath {
  readonly taskId: string;
}

export interface WorkspaceTaskListQuery {
  readonly cursorCreatedAt?: string;
  readonly cursorTaskId?: string;
  readonly pageSize?: number;
}

export type WorkspaceTaskStatus = "completed" | "open";

export interface WorkspaceTask {
  readonly assigneePrincipalId: string;
  readonly completedAt: string | null;
  readonly completionNote: string | null;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly description: string | null;
  readonly dueOn: string | null;
  readonly idempotencyKey: string;
  readonly status: WorkspaceTaskStatus;
  readonly taskId: string;
  readonly tenantId: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface WorkspaceTaskCursor {
  readonly createdAt: string;
  readonly taskId: string;
}

export interface AssignedWorkspaceTaskSummary {
  readonly createdAt: string;
  readonly createdByDisplayName: string;
  readonly description: string | null;
  readonly dueOn: string | null;
  readonly taskId: string;
  readonly title: string;
  readonly version: number;
  readonly workItemId: string;
}

export interface AssignedWorkspaceTaskPage {
  readonly items: readonly AssignedWorkspaceTaskSummary[];
  readonly nextCursor: WorkspaceTaskCursor | null;
}

export interface WorkspaceTaskEvidenceEvent {
  readonly eventType: "evidence.workspace.task.completed" | "evidence.workspace.task.created";
  readonly newState: WorkspaceTaskStatus;
  readonly occurredAt: string;
  readonly priorState: "open" | null;
}

export interface WorkspaceTaskDetail {
  readonly history: readonly WorkspaceTaskEvidenceEvent[];
  readonly task: WorkspaceTask;
}

export const workspaceCreateTaskBodySchema = {
  $id: "WorkspaceCreateTask",
  additionalProperties: false,
  properties: {
    assigneePrincipalId: { pattern: uuidPattern, type: "string" },
    description: { anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }] },
    dueOn: { anyOf: [{ pattern: datePattern, type: "string" }, { type: "null" }] },
    title: { maxLength: 160, minLength: 1, type: "string" },
  },
  required: ["assigneePrincipalId", "title"],
  type: "object",
} as const;

export const workspaceCompleteTaskBodySchema = {
  $id: "WorkspaceCompleteTask",
  additionalProperties: false,
  properties: {
    completionNote: {
      anyOf: [{ maxLength: 2000, minLength: 1, type: "string" }, { type: "null" }],
    },
    expectedVersion: { minimum: 1, type: "integer" },
  },
  required: ["expectedVersion"],
  type: "object",
} as const;

export const workspaceTaskPathSchema = {
  $id: "WorkspaceTaskPath",
  additionalProperties: false,
  properties: { taskId: { pattern: uuidPattern, type: "string" } },
  required: ["taskId"],
  type: "object",
} as const;

export const workspaceTaskListQuerySchema = {
  $id: "WorkspaceTaskListQuery",
  additionalProperties: false,
  dependencies: {
    cursorCreatedAt: ["cursorTaskId"],
    cursorTaskId: ["cursorCreatedAt"],
  },
  properties: {
    cursorCreatedAt: { format: "date-time", type: "string" },
    cursorTaskId: { pattern: uuidPattern, type: "string" },
    pageSize: { default: 50, maximum: 50, minimum: 1, type: "integer" },
  },
  type: "object",
} as const;

export const workspaceTaskSchema = {
  $id: "WorkspaceTask",
  additionalProperties: false,
  properties: {
    assigneePrincipalId: { pattern: uuidPattern, type: "string" },
    completedAt: { anyOf: [{ format: "date-time", type: "string" }, { type: "null" }] },
    completionNote: { anyOf: [{ maxLength: 2000, type: "string" }, { type: "null" }] },
    correlationId: { pattern: uuidPattern, type: "string" },
    createdAt: { format: "date-time", type: "string" },
    createdByPrincipalId: { pattern: uuidPattern, type: "string" },
    description: { anyOf: [{ maxLength: 2000, type: "string" }, { type: "null" }] },
    dueOn: { anyOf: [{ pattern: datePattern, type: "string" }, { type: "null" }] },
    idempotencyKey: { maxLength: 128, minLength: 1, type: "string" },
    status: { enum: ["open", "completed"] },
    taskId: { pattern: uuidPattern, type: "string" },
    tenantId: { pattern: uuidPattern, type: "string" },
    title: { maxLength: 160, minLength: 1, type: "string" },
    updatedAt: { format: "date-time", type: "string" },
    version: { minimum: 1, type: "integer" },
  },
  required: [
    "assigneePrincipalId",
    "completedAt",
    "completionNote",
    "correlationId",
    "createdAt",
    "createdByPrincipalId",
    "description",
    "dueOn",
    "idempotencyKey",
    "status",
    "taskId",
    "tenantId",
    "title",
    "updatedAt",
    "version",
  ],
  type: "object",
} as const;

export const assignedWorkspaceTaskSchema = {
  $id: "AssignedWorkspaceTask",
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    createdByDisplayName: { maxLength: 160, minLength: 1, type: "string" },
    description: { anyOf: [{ maxLength: 2000, type: "string" }, { type: "null" }] },
    dueOn: { anyOf: [{ pattern: datePattern, type: "string" }, { type: "null" }] },
    taskId: { pattern: uuidPattern, type: "string" },
    title: { maxLength: 160, minLength: 1, type: "string" },
    version: { minimum: 1, type: "integer" },
    workItemId: { pattern: uuidPattern, type: "string" },
  },
  required: [
    "createdAt",
    "createdByDisplayName",
    "description",
    "dueOn",
    "taskId",
    "title",
    "version",
    "workItemId",
  ],
  type: "object",
} as const;

export const assignedWorkspaceTaskPageSchema = {
  $id: "AssignedWorkspaceTaskPage",
  additionalProperties: false,
  properties: {
    items: { items: { $ref: "AssignedWorkspaceTask#" }, maxItems: 50, type: "array" },
    nextCursor: {
      anyOf: [
        {
          additionalProperties: false,
          properties: {
            createdAt: { format: "date-time", type: "string" },
            taskId: { pattern: uuidPattern, type: "string" },
          },
          required: ["createdAt", "taskId"],
          type: "object",
        },
        { type: "null" },
      ],
    },
  },
  required: ["items", "nextCursor"],
  type: "object",
} as const;

export const workspaceTaskEvidenceEventSchema = {
  $id: "WorkspaceTaskEvidenceEvent",
  additionalProperties: false,
  properties: {
    eventType: {
      enum: ["evidence.workspace.task.created", "evidence.workspace.task.completed"],
    },
    newState: { enum: ["open", "completed"] },
    occurredAt: { format: "date-time", type: "string" },
    priorState: { anyOf: [{ enum: ["open"] }, { type: "null" }] },
  },
  required: ["eventType", "newState", "occurredAt", "priorState"],
  type: "object",
} as const;

export const workspaceTaskDetailSchema = {
  $id: "WorkspaceTaskDetail",
  additionalProperties: false,
  properties: {
    history: {
      items: { $ref: "WorkspaceTaskEvidenceEvent#" },
      maxItems: 100,
      minItems: 1,
      type: "array",
    },
    task: { $ref: "WorkspaceTask#" },
  },
  required: ["history", "task"],
  type: "object",
} as const;

const taskKeys = [
  "assigneePrincipalId",
  "completedAt",
  "completionNote",
  "correlationId",
  "createdAt",
  "createdByPrincipalId",
  "description",
  "dueOn",
  "idempotencyKey",
  "status",
  "taskId",
  "tenantId",
  "title",
  "updatedAt",
  "version",
] as const;
const assignedTaskKeys = [
  "createdAt",
  "createdByDisplayName",
  "description",
  "dueOn",
  "taskId",
  "title",
  "version",
  "workItemId",
] as const;
const evidenceKeys = ["eventType", "newState", "occurredAt", "priorState"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unexpected keys`);
  }
}

function assertUuid(value: unknown, label: string) {
  if (typeof value !== "string" || !new RegExp(uuidPattern).test(value)) {
    throw new TypeError(`${label} must be a UUID`);
  }
}

function assertDateTime(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    !dateTimePattern.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError(`${label} must be an ISO date-time`);
  }
}

function assertNullableDate(value: unknown, label: string) {
  if (value === null) return;
  if (typeof value !== "string" || !new RegExp(datePattern).test(value)) {
    throw new TypeError(`${label} must be a date or null`);
  }
}

function assertNullableText(value: unknown, label: string, maximum: number) {
  if (value === null) return;
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`${label} must be text or null`);
  }
}

function assertTask(value: unknown, label: string): asserts value is WorkspaceTask {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, taskKeys, label);
  assertUuid(value.taskId, `${label}.taskId`);
  assertUuid(value.tenantId, `${label}.tenantId`);
  assertUuid(value.createdByPrincipalId, `${label}.createdByPrincipalId`);
  assertUuid(value.assigneePrincipalId, `${label}.assigneePrincipalId`);
  assertUuid(value.correlationId, `${label}.correlationId`);
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 160) {
    throw new TypeError(`${label}.title is invalid`);
  }
  assertNullableText(value.description, `${label}.description`, 2000);
  assertNullableText(value.completionNote, `${label}.completionNote`, 2000);
  assertNullableDate(value.dueOn, `${label}.dueOn`);
  assertDateTime(value.createdAt, `${label}.createdAt`);
  assertDateTime(value.updatedAt, `${label}.updatedAt`);
  if (value.completedAt !== null) assertDateTime(value.completedAt, `${label}.completedAt`);
  if (value.status !== "open" && value.status !== "completed") {
    throw new TypeError(`${label}.status is invalid`);
  }
  if (value.status === "open" && (value.completedAt !== null || value.completionNote !== null)) {
    throw new TypeError(`${label}.open task cannot have completion data`);
  }
  if (value.status === "completed" && value.completedAt === null) {
    throw new TypeError(`${label}.completed task must have completedAt`);
  }
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 1) {
    throw new TypeError(`${label}.idempotencyKey is invalid`);
  }
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new TypeError(`${label}.version must be a positive integer`);
  }
}

function assertAssignedTask(
  value: unknown,
  label: string,
): asserts value is AssignedWorkspaceTaskSummary {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, assignedTaskKeys, label);
  assertUuid(value.taskId, `${label}.taskId`);
  assertUuid(value.workItemId, `${label}.workItemId`);
  if (
    typeof value.createdByDisplayName !== "string" ||
    value.createdByDisplayName.length < 1 ||
    value.createdByDisplayName.length > 160
  ) {
    throw new TypeError(`${label}.createdByDisplayName is invalid`);
  }
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 160) {
    throw new TypeError(`${label}.title is invalid`);
  }
  assertNullableText(value.description, `${label}.description`, 2000);
  assertNullableDate(value.dueOn, `${label}.dueOn`);
  assertDateTime(value.createdAt, `${label}.createdAt`);
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1) {
    throw new TypeError(`${label}.version must be a positive integer`);
  }
}

function assertEvidence(
  value: unknown,
  label: string,
): asserts value is WorkspaceTaskEvidenceEvent {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  assertExactKeys(value, evidenceKeys, label);
  assertDateTime(value.occurredAt, `${label}.occurredAt`);
  if (value.eventType === "evidence.workspace.task.created") {
    if (value.priorState !== null || value.newState !== "open") {
      throw new TypeError(`${label} does not prove task creation`);
    }
    return;
  }
  if (value.eventType === "evidence.workspace.task.completed") {
    if (value.priorState !== "open" || value.newState !== "completed") {
      throw new TypeError(`${label} does not prove task completion`);
    }
    return;
  }
  throw new TypeError(`${label}.eventType is invalid`);
}

export function parseWorkspaceTask(value: unknown): WorkspaceTask {
  assertTask(value, "WorkspaceTask");
  return value;
}

export function parseAssignedWorkspaceTaskPage(value: unknown): AssignedWorkspaceTaskPage {
  if (!isRecord(value)) throw new TypeError("AssignedWorkspaceTaskPage must be an object");
  assertExactKeys(value, ["items", "nextCursor"], "AssignedWorkspaceTaskPage");
  if (!Array.isArray(value.items) || value.items.length > 50) {
    throw new TypeError("AssignedWorkspaceTaskPage.items must contain at most 50 tasks");
  }
  value.items.forEach((item, index) => {
    assertAssignedTask(item, `items[${index}]`);
  });
  if (value.nextCursor !== null) {
    if (!isRecord(value.nextCursor)) throw new TypeError("nextCursor must be an object or null");
    assertExactKeys(value.nextCursor, ["createdAt", "taskId"], "nextCursor");
    assertUuid(value.nextCursor.taskId, "nextCursor.taskId");
    assertDateTime(value.nextCursor.createdAt, "nextCursor.createdAt");
  }
  return value as unknown as AssignedWorkspaceTaskPage;
}

export function parseWorkspaceTaskDetail(value: unknown): WorkspaceTaskDetail {
  if (!isRecord(value)) throw new TypeError("WorkspaceTaskDetail must be an object");
  assertExactKeys(value, ["history", "task"], "WorkspaceTaskDetail");
  assertTask(value.task, "WorkspaceTaskDetail.task");
  if (!Array.isArray(value.history) || value.history.length < 1 || value.history.length > 100) {
    throw new TypeError("WorkspaceTaskDetail.history must contain between 1 and 100 events");
  }
  let priorState: WorkspaceTaskStatus | null = null;
  value.history.forEach((event, index) => {
    assertEvidence(event, `WorkspaceTaskDetail.history[${index}]`);
    if (index === 0 && (event.priorState !== null || event.newState !== "open")) {
      throw new TypeError("WorkspaceTaskDetail.history must begin with creation");
    }
    if (index > 0 && event.priorState !== priorState) {
      throw new TypeError("WorkspaceTaskDetail.history is not contiguous");
    }
    priorState = event.newState;
  });
  if (priorState !== value.task.status) {
    throw new TypeError("WorkspaceTaskDetail.history does not prove current task status");
  }
  return value as unknown as WorkspaceTaskDetail;
}
