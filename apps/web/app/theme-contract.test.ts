import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ESBLA_THEME_ID, ESBLA_THEME_MODES } from "./theme-contract";

describe("Esbla Theme v1 host contract", () => {
  it("names the normalized theme and all three required modes", () => {
    expect(ESBLA_THEME_ID).toBe("esbla_v1");
    expect(ESBLA_THEME_MODES).toEqual(["light", "dark", "high-contrast"]);
  });

  it("keeps one scroll surface, safe-area tokens, responsive geometry, and reduced motion", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    expect(css).toContain("--surface-frame-top: 72px");
    expect(css).toContain("--corner-button: 46px");
    expect(css).toContain(".surface-scroll");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("@media (max-width: 760px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("routes to My Work and hosts HR plus Workspace task interactions", async () => {
    const entry = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
    const surfaces = await readFile(new URL("./workspace-surfaces.ts", import.meta.url), "utf8");
    const shell = await readFile(new URL("./workspace-shell.tsx", import.meta.url), "utf8");
    const myWork = await readFile(new URL("./workspace/my-work/page.tsx", import.meta.url), "utf8");
    const taskComplete = await readFile(
      new URL("./workspace/my-work/task-complete-action.tsx", import.meta.url),
      "utf8",
    );
    const tasks = await readFile(new URL("./workspace/tasks/page.tsx", import.meta.url), "utf8");
    const approval = await readFile(
      new URL("./workspace/my-work/leave-approval-action.tsx", import.meta.url),
      "utf8",
    );
    const rejection = await readFile(
      new URL("./workspace/my-work/leave-rejection-action.tsx", import.meta.url),
      "utf8",
    );
    expect(entry).toContain('redirect("/workspace/my-work")');
    expect(myWork).toContain("Assigned work");
    expect(myWork).toContain("LeaveApprovalAction");
    expect(myWork).toContain("LeaveRejectionAction");
    expect(myWork).toContain("TaskCompleteAction");
    expect(approval).toContain("Confirm approval");
    expect(approval).toContain("records approval evidence");
    expect(approval).not.toContain("Reject request");
    expect(rejection).toContain("Confirm rejection");
    expect(rejection).toContain("records rejection evidence");
    expect(rejection).toContain("Tenant policy may require a note");
    expect(taskComplete).toContain("Complete this task?");
    expect(taskComplete).toContain("records completion evidence");
    expect(tasks).toContain("Workspace Tasks");
    expect(tasks).toContain("New task");
    expect(surfaces).toContain("WORKSPACE_SURFACES");
    expect(surfaces).toContain('href: "/workspace/my-work"');
    expect(surfaces).toContain('href: "/workspace/tasks"');
    expect(surfaces).toContain('href: "/workspace/hr"');
    expect(shell).toContain("WORKSPACE_SURFACES.map");
    expect(shell).not.toContain("statusLabel: string");
    expect(shell).not.toContain('currentSurface === "HR"');
  });

  it("keeps My Work decision controls accessible and policy-bound", async () => {
    const myWork = await readFile(new URL("./workspace/my-work/page.tsx", import.meta.url), "utf8");
    const approval = await readFile(
      new URL("./workspace/my-work/leave-approval-action.tsx", import.meta.url),
      "utf8",
    );
    const rejection = await readFile(
      new URL("./workspace/my-work/leave-rejection-action.tsx", import.meta.url),
      "utf8",
    );
    const taskComplete = await readFile(
      new URL("./workspace/my-work/task-complete-action.tsx", import.meta.url),
      "utf8",
    );
    expect(myWork).toContain('aria-label="Assigned leave approvals"');
    expect(myWork).toContain('aria-label="Assigned workspace tasks"');
    expect(myWork).toContain('aria-label="Assigned approval pages"');
    expect(approval).toContain('aria-label="Approve leave request"');
    expect(rejection).toContain('aria-label="Reject leave request"');
    expect(taskComplete).toContain('aria-label="Complete workspace task"');
    expect(rejection).toContain("htmlFor={`rejection-note-");
    expect(rejection).toContain('aria-invalid={noteError ? "true" : undefined}');
    expect(rejection).toContain("decisionNote");
    expect(rejection).not.toContain("employeePrincipalId");
    expect(rejection).not.toContain("tenantId");
  });

  it("hosts read-only leave detail, evidence, loading, error, and not-found states", async () => {
    const detailRoot = new URL("./workspace/hr/leave/[leaveRequestId]/", import.meta.url);
    const [page, loading, error, notFound] = await Promise.all(
      ["page.tsx", "loading.tsx", "error.tsx", "not-found.tsx"].map(
        async (file) => await readFile(new URL(file, detailRoot), "utf8"),
      ),
    );
    expect(page).toContain("Evidence history");
    expect(page).toContain("Request details");
    expect(page).not.toContain("<form");
    expect(page).not.toContain("<button");
    expect(page).not.toContain("/approve");
    expect(page).not.toContain("/reject");
    expect(loading).toContain('aria-busy="true"');
    expect(error).toContain('role="alert"');
    expect(notFound).toContain("Leave request not found");
  });
});
