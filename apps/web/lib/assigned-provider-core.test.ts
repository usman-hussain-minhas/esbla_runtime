import type {
  HrAssignedLeaveRequestPage,
  HrLeaveRequestCursor,
} from "@esbla/contracts/hr-leave-api";
import type {
  AssignedWorkspaceTaskPage,
  WorkspaceTaskCursor,
} from "@esbla/contracts/workspace-task-api";
import { describe, expect, it, vi } from "vitest";
import {
  type AssignedProvider,
  AssignedProviderCursorError,
  AssignedProviderUnavailableError,
  loadAssignedProviderView,
  parseAssignedProviderCursors,
} from "./assigned-provider-core";

const hrCurrent = {
  leaveRequestId: "11111111-1111-4111-8111-111111111111",
  submittedAt: "2026-07-10T00:00:00.000Z",
} satisfies HrLeaveRequestCursor;
const hrNext = {
  leaveRequestId: "22222222-2222-4222-8222-222222222222",
  submittedAt: "2026-07-11T00:00:00.000Z",
} satisfies HrLeaveRequestCursor;
const workspaceCurrent = {
  createdAt: "2026-07-12T00:00:00.000Z",
  taskId: "33333333-3333-4333-8333-333333333333",
} satisfies WorkspaceTaskCursor;
const workspaceNext = {
  createdAt: "2026-07-13T00:00:00.000Z",
  taskId: "44444444-4444-4444-8444-444444444444",
} satisfies WorkspaceTaskCursor;

const hrItem = {
  categoryCode: "annual",
  employeeDisplayName: "Employee A",
  endDate: "2026-07-12",
  leaveRequestId: "55555555-5555-4555-8555-555555555555",
  reason: null,
  startDate: "2026-07-11",
  submittedAt: "2026-07-10T00:00:00.000Z",
  version: 1,
  workItemId: "66666666-6666-4666-8666-666666666666",
} as const;
const workspaceItem = {
  createdAt: "2026-07-10T00:00:00.000Z",
  createdByDisplayName: "Creator A",
  description: null,
  dueOn: null,
  taskId: "77777777-7777-4777-8777-777777777777",
  title: "Prepare proof",
  version: 1,
  workItemId: "88888888-8888-4888-8888-888888888888",
} as const;

function hrPage(
  items: HrAssignedLeaveRequestPage["items"] = [],
  nextCursor: HrLeaveRequestCursor | null = null,
): HrAssignedLeaveRequestPage {
  return { items, nextCursor };
}

function workspacePage(
  items: AssignedWorkspaceTaskPage["items"] = [],
  nextCursor: WorkspaceTaskCursor | null = null,
): AssignedWorkspaceTaskPage {
  return { items, nextCursor };
}

function searchParams(
  hr: HrLeaveRequestCursor | undefined = undefined,
  workspace: WorkspaceTaskCursor | undefined = undefined,
) {
  return {
    ...(hr
      ? {
          cursorLeaveRequestId: hr.leaveRequestId,
          cursorSubmittedAt: hr.submittedAt,
        }
      : {}),
    ...(workspace
      ? {
          cursorCreatedAt: workspace.createdAt,
          cursorTaskId: workspace.taskId,
        }
      : {}),
  };
}

function deferred<T>() {
  let reject!: (reason: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function query(href: string | null) {
  expect(href).not.toBeNull();
  return new URL(href as string, "https://example.test").searchParams;
}

describe("assigned provider core", () => {
  it("constructs only exact sanitized provider-unavailable signals", () => {
    const error = new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
    expect(error).toMatchObject({ provider: "hr_leave_assigned", reason: "inactive" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("detail");
    expect(error.message).not.toContain("inactive");
    expect(error.stack).not.toContain("upstream-secret");
    expect(
      () => new AssignedProviderUnavailableError("external" as AssignedProvider, "inactive"),
    ).toThrow();
    expect(
      () => new AssignedProviderUnavailableError("hr_leave_assigned", "operational" as "inactive"),
    ).toThrow();
  });

  it("parses only genuinely absent or complete scalar cursor families", () => {
    expect(parseAssignedProviderCursors({ unrelated: "value" })).toEqual({
      hr: undefined,
      workspace: undefined,
    });
    expect(parseAssignedProviderCursors(searchParams(hrCurrent, workspaceCurrent))).toEqual({
      hr: hrCurrent,
      workspace: workspaceCurrent,
    });
    expect(
      parseAssignedProviderCursors({
        cursorLeaveRequestId: hrCurrent.leaveRequestId,
        cursorSubmittedAt: "2024-02-29T23:30:00-02:00",
      }).hr,
    ).toEqual({
      leaveRequestId: hrCurrent.leaveRequestId,
      submittedAt: "2024-02-29T23:30:00-02:00",
    });
  });

  it.each([
    ["HR partial", { cursorLeaveRequestId: hrCurrent.leaveRequestId }, "hr_leave_assigned"],
    ["HR timestamp only", { cursorSubmittedAt: hrCurrent.submittedAt }, "hr_leave_assigned"],
    ["HR empty", { cursorLeaveRequestId: "", cursorSubmittedAt: "" }, "hr_leave_assigned"],
    [
      "HR duplicate",
      {
        cursorLeaveRequestId: [hrCurrent.leaveRequestId],
        cursorSubmittedAt: hrCurrent.submittedAt,
      },
      "hr_leave_assigned",
    ],
    [
      "HR timestamp array",
      {
        cursorLeaveRequestId: hrCurrent.leaveRequestId,
        cursorSubmittedAt: [hrCurrent.submittedAt],
      },
      "hr_leave_assigned",
    ],
    [
      "HR own undefined",
      { cursorLeaveRequestId: undefined, cursorSubmittedAt: undefined },
      "hr_leave_assigned",
    ],
    [
      "HR bad UUID",
      { cursorLeaveRequestId: "bad", cursorSubmittedAt: hrCurrent.submittedAt },
      "hr_leave_assigned",
    ],
    [
      "HR rollover date",
      {
        cursorLeaveRequestId: hrCurrent.leaveRequestId,
        cursorSubmittedAt: "2026-02-30T00:00:00.000Z",
      },
      "hr_leave_assigned",
    ],
    [
      "HR rollover hour",
      {
        cursorLeaveRequestId: hrCurrent.leaveRequestId,
        cursorSubmittedAt: "2026-01-01T24:00:00.000Z",
      },
      "hr_leave_assigned",
    ],
    ["Workspace partial", { cursorTaskId: workspaceCurrent.taskId }, "workspace_task_assigned"],
    [
      "Workspace timestamp only",
      { cursorCreatedAt: workspaceCurrent.createdAt },
      "workspace_task_assigned",
    ],
    ["Workspace empty", { cursorCreatedAt: "", cursorTaskId: "" }, "workspace_task_assigned"],
    [
      "Workspace own undefined",
      { cursorCreatedAt: undefined, cursorTaskId: undefined },
      "workspace_task_assigned",
    ],
    [
      "Workspace bad UUID",
      { cursorCreatedAt: workspaceCurrent.createdAt, cursorTaskId: "bad" },
      "workspace_task_assigned",
    ],
    [
      "Workspace array",
      { cursorCreatedAt: workspaceCurrent.createdAt, cursorTaskId: [workspaceCurrent.taskId] },
      "workspace_task_assigned",
    ],
    [
      "Workspace timestamp array",
      { cursorCreatedAt: [workspaceCurrent.createdAt], cursorTaskId: workspaceCurrent.taskId },
      "workspace_task_assigned",
    ],
    [
      "Workspace date-only",
      { cursorCreatedAt: "2026-07-12", cursorTaskId: workspaceCurrent.taskId },
      "workspace_task_assigned",
    ],
    [
      "cross-family pair",
      {
        cursorCreatedAt: workspaceCurrent.createdAt,
        cursorLeaveRequestId: hrCurrent.leaveRequestId,
      },
      "hr_leave_assigned",
    ],
    [
      "reverse cross-family pair",
      { cursorSubmittedAt: hrCurrent.submittedAt, cursorTaskId: workspaceCurrent.taskId },
      "hr_leave_assigned",
    ],
  ])("rejects %s without normalizing to page one", (_label, parameters, provider) => {
    expect(() => parseAssignedProviderCursors(parameters)).toThrowError(
      expect.objectContaining({ provider }),
    );
  });

  it("selects the HR cursor failure when both families are malformed", () => {
    expect(() =>
      parseAssignedProviderCursors({
        cursorCreatedAt: "bad",
        cursorLeaveRequestId: "bad",
        cursorSubmittedAt: "bad",
        cursorTaskId: "bad",
      }),
    ).toThrowError(expect.objectContaining({ provider: "hr_leave_assigned" }));
  });

  it.each([
    ["HR", { cursorLeaveRequestId: "bad", cursorSubmittedAt: "bad" }],
    ["Workspace", { cursorCreatedAt: "bad", cursorTaskId: "bad" }],
    [
      "both",
      {
        cursorCreatedAt: "bad",
        cursorLeaveRequestId: "bad",
        cursorSubmittedAt: "bad",
        cursorTaskId: "bad",
      },
    ],
  ])("rejects invalid %s cursors before either loader runs", async (_label, parameters) => {
    const loadHr = vi.fn(async () => hrPage());
    const loadWorkspace = vi.fn(async () => workspacePage());
    await expect(
      loadAssignedProviderView({ loadHr, loadWorkspace, searchParams: parameters }),
    ).rejects.toBeInstanceOf(AssignedProviderCursorError);
    expect(loadHr).not.toHaveBeenCalled();
    expect(loadWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    ["available/available", "available", "available", "view"],
    ["available/unavailable", "available", "unavailable", "view"],
    ["unavailable/available", "unavailable", "available", "view"],
    ["unavailable/unavailable", "unavailable", "unavailable", "view"],
    ["available/fatal", "available", "fatal", "workspace-fatal"],
    ["unavailable/fatal", "unavailable", "fatal", "workspace-fatal"],
    ["fatal/available", "fatal", "available", "hr-fatal"],
    ["fatal/unavailable", "fatal", "unavailable", "hr-fatal"],
    ["fatal/fatal", "fatal", "fatal", "hr-fatal"],
  ] as const)("settles the %s matrix deterministically", async (_label, hr, workspace, outcome) => {
    const hrFatal = new Error("hr-fatal");
    const workspaceFatal = new Error("workspace-fatal");
    const loadHr = vi.fn(() => {
      if (hr === "fatal") return Promise.reject(hrFatal);
      if (hr === "unavailable") {
        return Promise.reject(
          new AssignedProviderUnavailableError("hr_leave_assigned", "inactive"),
        );
      }
      return Promise.resolve(hrPage([hrItem]));
    });
    const loadWorkspace = vi.fn(() => {
      if (workspace === "fatal") return Promise.reject(workspaceFatal);
      if (workspace === "unavailable") {
        return Promise.reject(
          new AssignedProviderUnavailableError("workspace_task_assigned", "inactive"),
        );
      }
      return Promise.resolve(workspacePage([workspaceItem]));
    });
    const result = loadAssignedProviderView({ loadHr, loadWorkspace, searchParams: {} });
    if (outcome === "hr-fatal") await expect(result).rejects.toBe(hrFatal);
    else if (outcome === "workspace-fatal") await expect(result).rejects.toBe(workspaceFatal);
    else {
      const view = await result;
      expect(view.hr).toEqual(
        hr === "available"
          ? { empty: false, page: hrPage([hrItem]), unavailable: false }
          : { unavailable: true },
      );
      expect(view.workspace).toEqual(
        workspace === "available"
          ? { empty: false, page: workspacePage([workspaceItem]), unavailable: false }
          : { unavailable: true },
      );
      expect(view.totalShown).toBe(Number(hr === "available") + Number(workspace === "available"));
      expect(view.queuesClear).toBe(false);
    }
    expect(loadHr).toHaveBeenCalledTimes(1);
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it("starts both synchronous loaders and keeps HR as first fatal", async () => {
    const hrFatal = new Error("hr-sync-fatal");
    const workspaceFatal = new Error("workspace-sync-fatal");
    const loadHr = vi.fn((): Promise<HrAssignedLeaveRequestPage> => {
      throw hrFatal;
    });
    const loadWorkspace = vi.fn((): Promise<AssignedWorkspaceTaskPage> => {
      throw workspaceFatal;
    });
    await expect(
      loadAssignedProviderView({ loadHr, loadWorkspace, searchParams: {} }),
    ).rejects.toBe(hrFatal);
    expect(loadHr).toHaveBeenCalledTimes(1);
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
  });

  it("awaits an asynchronous Workspace rejection after a synchronous HR throw", async () => {
    const hrFatal = new Error("hr-sync-fatal");
    const workspaceFatal = new Error("workspace-async-fatal");
    const workspace = deferred<AssignedWorkspaceTaskPage>();
    const loadHr = vi.fn((): Promise<HrAssignedLeaveRequestPage> => {
      throw hrFatal;
    });
    const loadWorkspace = vi.fn(() => workspace.promise);
    const subject = loadAssignedProviderView({ loadHr, loadWorkspace, searchParams: {} });
    let settled = false;
    void subject
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadHr).toHaveBeenCalledTimes(1);
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    workspace.reject(workspaceFatal);
    await expect(subject).rejects.toBe(hrFatal);
  });

  it("awaits an asynchronous HR rejection after a synchronous Workspace throw", async () => {
    const hrFatal = new Error("hr-async-fatal");
    const workspaceFatal = new Error("workspace-sync-fatal");
    const hr = deferred<HrAssignedLeaveRequestPage>();
    const loadHr = vi.fn(() => hr.promise);
    const loadWorkspace = vi.fn((): Promise<AssignedWorkspaceTaskPage> => {
      throw workspaceFatal;
    });
    const subject = loadAssignedProviderView({ loadHr, loadWorkspace, searchParams: {} });
    let settled = false;
    void subject
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(loadHr).toHaveBeenCalledTimes(1);
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    hr.reject(hrFatal);
    await expect(subject).rejects.toBe(hrFatal);
  });

  it("waits for HR classification when Workspace fails first", async () => {
    const hr = deferred<HrAssignedLeaveRequestPage>();
    const hrFatal = new Error("hr-later-fatal");
    const workspaceFatal = new Error("workspace-first-fatal");
    const subject = loadAssignedProviderView({
      loadHr: () => hr.promise,
      loadWorkspace: async () => {
        throw workspaceFatal;
      },
      searchParams: {},
    });
    let settled = false;
    void subject
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    hr.reject(hrFatal);
    await expect(subject).rejects.toBe(hrFatal);
  });

  it("awaits a later Workspace settlement before selecting an HR fatal", async () => {
    const hrFatal = new Error("hr-fatal");
    const workspaceFatal = new Error("workspace-later-fatal");
    const workspace = deferred<AssignedWorkspaceTaskPage>();
    const loadWorkspace = vi.fn(() => workspace.promise);
    const subject = loadAssignedProviderView({
      loadHr: async () => {
        throw hrFatal;
      },
      loadWorkspace,
      searchParams: {},
    });
    await expect(
      Promise.race([
        subject.catch((error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve("still-pending"), 50)),
      ]),
    ).resolves.toBe("still-pending");
    expect(loadWorkspace).toHaveBeenCalledTimes(1);
    workspace.reject(workspaceFatal);
    await expect(subject).rejects.toBe(hrFatal);
  });

  it("treats duck-typed or provider-mismatched unavailable errors as fatal", async () => {
    const duck = {
      name: "AssignedProviderUnavailableError",
      provider: "hr_leave_assigned",
      reason: "inactive",
    };
    await expect(
      loadAssignedProviderView({
        loadHr: async () => {
          throw duck;
        },
        loadWorkspace: async () => workspacePage(),
        searchParams: {},
      }),
    ).rejects.toBe(duck);
    const mismatch = new AssignedProviderUnavailableError("workspace_task_assigned", "inactive");
    await expect(
      loadAssignedProviderView({
        loadHr: async () => {
          throw mismatch;
        },
        loadWorkspace: async () => workspacePage(),
        searchParams: {},
      }),
    ).rejects.toBe(mismatch);
  });

  it("keeps unavailable reasons out of the immutable public view model", async () => {
    const inactive = await loadAssignedProviderView({
      loadHr: async () => {
        throw new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
      },
      loadWorkspace: async () => workspacePage(),
      searchParams: {},
    });
    const ineligible = await loadAssignedProviderView({
      loadHr: async () => {
        throw new AssignedProviderUnavailableError("hr_leave_assigned", "ineligible");
      },
      loadWorkspace: async () => workspacePage(),
      searchParams: {},
    });
    expect(inactive.hr).toEqual({ unavailable: true });
    expect(ineligible.hr).toEqual(inactive.hr);
    expect(JSON.stringify(inactive)).not.toMatch(/inactive|ineligible|reason|error/i);
    expect(Object.isFrozen(inactive)).toBe(true);
    expect(Object.isFrozen(inactive.hr)).toBe(true);
  });

  it.each([
    [0, 0, false, false, 0, false],
    [0, 0, false, true, 0, false],
    [0, 0, true, false, 0, false],
    [0, 0, true, true, 0, true],
    [1, 0, true, true, 1, false],
    [1, 1, true, true, 2, false],
  ])("computes count and clear truth for HR %i Workspace %i availability %s/%s", async (hrCount, workspaceCount, hrAvailable, workspaceAvailable, total, clear) => {
    const view = await loadAssignedProviderView({
      loadHr: async () => {
        if (!hrAvailable) {
          throw new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
        }
        return hrPage(hrCount ? [hrItem] : []);
      },
      loadWorkspace: async () => {
        if (!workspaceAvailable) {
          throw new AssignedProviderUnavailableError("workspace_task_assigned", "inactive");
        }
        return workspacePage(workspaceCount ? [workspaceItem] : []);
      },
      searchParams: {},
    });
    expect(view.totalShown).toBe(total);
    expect(view.queuesClear).toBe(clear);
    if (!view.hr.unavailable) expect(view.hr.empty).toBe(hrCount === 0);
    if (!view.workspace.unavailable) expect(view.workspace.empty).toBe(workspaceCount === 0);
  });

  it("builds independent next links from advancing next and foreign current cursors", async () => {
    const view = await loadAssignedProviderView({
      loadHr: async () => hrPage([], hrNext),
      loadWorkspace: async () => workspacePage([], workspaceNext),
      searchParams: searchParams(hrCurrent, workspaceCurrent),
    });
    expect(Object.fromEntries(query(view.nextApprovalsHref))).toEqual({
      cursorCreatedAt: workspaceCurrent.createdAt,
      cursorLeaveRequestId: hrNext.leaveRequestId,
      cursorSubmittedAt: hrNext.submittedAt,
      cursorTaskId: workspaceCurrent.taskId,
    });
    expect(Object.fromEntries(query(view.nextTasksHref))).toEqual({
      cursorCreatedAt: workspaceNext.createdAt,
      cursorLeaveRequestId: hrCurrent.leaveRequestId,
      cursorSubmittedAt: hrCurrent.submittedAt,
      cursorTaskId: workspaceNext.taskId,
    });
    expect(view.startOverHref).toBe("/workspace/my-work");
  });

  it("does not claim cursor-positioned empty pages prove both queues are clear", async () => {
    const view = await loadAssignedProviderView({
      loadHr: async () => hrPage(),
      loadWorkspace: async () => workspacePage(),
      searchParams: searchParams(hrCurrent, workspaceCurrent),
    });
    expect(view.queuesClear).toBe(false);
    expect(view.startOverHref).toBe("/workspace/my-work");
  });

  it("does not claim empty initial pages with next cursors prove both queues are clear", async () => {
    const view = await loadAssignedProviderView({
      loadHr: async () => hrPage([], hrNext),
      loadWorkspace: async () => workspacePage([], workspaceNext),
      searchParams: {},
    });
    expect(view.queuesClear).toBe(false);
    expect(view.nextApprovalsHref).not.toBeNull();
    expect(view.nextTasksHref).not.toBeNull();
  });

  it("drops only an unavailable source cursor and preserves an available empty source cursor", async () => {
    const hrUnavailable = await loadAssignedProviderView({
      loadHr: async () => {
        throw new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
      },
      loadWorkspace: async () => workspacePage([], workspaceNext),
      searchParams: searchParams(hrCurrent, workspaceCurrent),
    });
    expect(Object.fromEntries(query(hrUnavailable.nextTasksHref))).toEqual({
      cursorCreatedAt: workspaceNext.createdAt,
      cursorTaskId: workspaceNext.taskId,
    });
    expect(hrUnavailable.startOverHref).toBe("/workspace/my-work");

    const workspaceUnavailable = await loadAssignedProviderView({
      loadHr: async () => hrPage([], hrNext),
      loadWorkspace: async () => {
        throw new AssignedProviderUnavailableError("workspace_task_assigned", "inactive");
      },
      searchParams: searchParams(hrCurrent, workspaceCurrent),
    });
    expect(Object.fromEntries(query(workspaceUnavailable.nextApprovalsHref))).toEqual({
      cursorLeaveRequestId: hrNext.leaveRequestId,
      cursorSubmittedAt: hrNext.submittedAt,
    });
    expect(workspaceUnavailable.startOverHref).toBe("/workspace/my-work");

    const bothUnavailable = await loadAssignedProviderView({
      loadHr: async () => {
        throw new AssignedProviderUnavailableError("hr_leave_assigned", "inactive");
      },
      loadWorkspace: async () => {
        throw new AssignedProviderUnavailableError("workspace_task_assigned", "inactive");
      },
      searchParams: searchParams(hrCurrent, workspaceCurrent),
    });
    expect(bothUnavailable).toMatchObject({
      nextApprovalsHref: null,
      nextTasksHref: null,
      startOverHref: null,
    });
  });

  it.each([
    ["HR", { ...hrNext, submittedAt: "2026-02-30T00:00:00.000Z" }, workspaceNext],
    ["Workspace", hrNext, { ...workspaceNext, createdAt: "2026-01-01T24:00:00.000Z" }],
  ])("revalidates malformed returned %s next cursors before building hrefs", async (_label, hr, ws) => {
    await expect(
      loadAssignedProviderView({
        loadHr: async () => hrPage([], hr),
        loadWorkspace: async () => workspacePage([], ws),
        searchParams: {},
      }),
    ).rejects.toBeInstanceOf(AssignedProviderCursorError);
  });
});
