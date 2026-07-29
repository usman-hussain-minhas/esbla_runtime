import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ESBLA_THEME_ALIASES, ESBLA_THEME_ID, ESBLA_THEME_PALETTES } from "./theme-contract";

describe("Esbla Theme v1 host contract", () => {
  it("names Zen and keeps palette separate from high contrast", () => {
    expect(ESBLA_THEME_ID).toBe("THEME-ESBLA-V1");
    expect(ESBLA_THEME_ALIASES).toContain("zen_theme");
    expect(ESBLA_THEME_PALETTES).toEqual(["light", "dark"]);
  });

  it("keeps one scroll surface, safe-area tokens, responsive geometry, and reduced motion", async () => {
    const css = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    expect(css).toContain("--surface-frame-top: 72px");
    expect(css).toContain("--corner-button: 46px");
    expect(css).toContain(".surface-scroll");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("@media (max-width: 1099px)");
    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toContain("env(safe-area-inset-top");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).not.toContain("--corner-button: 42px");
    expect(css).toContain(".surface-frame::after");
    expect(css).not.toContain(".surface-frame::before");
    expect(css).not.toContain("@media (max-width: 760px)");
    expect(css).not.toContain("@media (max-width: 980px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("has one canonical Theme identity and no competing light-only UI stub", async () => {
    const [sharedUi, tokens] = await Promise.all([
      readFile(new URL("../../../packages/ui/src/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../theme/zen-theme/v1/tokens.css", import.meta.url), "utf8"),
    ]);
    expect(sharedUi).not.toContain('"zen_v1"');
    expect(sharedUi).not.toContain('modes: ["light"]');
    expect(tokens).toContain('--zen-theme-id: "THEME-ESBLA-V1"');
    expect(tokens).not.toContain('--zen-theme-id: "zen-theme"');
  });

  it("uses a parallel intercepted Leave detail face with a direct standalone route", async () => {
    const [layout, widget, intercepted, standalone] = await Promise.all([
      readFile(new URL("./layout.tsx", import.meta.url), "utf8"),
      readFile(
        new URL("../theme/zen-theme/v1/widgets/hr-leave-my-requests-widget.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("./@modal/(.)workspace/hr/leave/[leaveRequestId]/page.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("./workspace/hr/leave/[leaveRequestId]/page.tsx", import.meta.url), "utf8"),
    ]);
    expect(layout).toContain("modal");
    expect(widget).toContain("Link");
    expect(widget).not.toContain("?focus=");
    expect(intercepted).toContain("RouteBackedWidgetOverlay");
    expect(intercepted).toContain("HrLeaveRequestDetailFace");
    expect(standalone).toContain("HrLeaveRequestDetailFace");
    expect(standalone).toContain("HR_LEAVE_CANONICAL_HOST_LINK");
  });

  it("routes home to Mission Control and keeps task workflows reachable as widgets", async () => {
    const entry = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
    const surfaces = await readFile(new URL("./workspace-surfaces.ts", import.meta.url), "utf8");
    const shell = await readFile(new URL("./workspace-shell.tsx", import.meta.url), "utf8");
    const systemControl = await readFile(
      new URL("../theme/zen-theme/v1/panels/zen-system-panel.tsx", import.meta.url),
      "utf8",
    );
    const navigation = await readFile(
      new URL("../theme/zen-theme/v1/chrome/zen-navigation-chrome.tsx", import.meta.url),
      "utf8",
    );
    const shellChrome = await readFile(
      new URL("../theme/zen-theme/v1/chrome/zen-shell-chrome.tsx", import.meta.url),
      "utf8",
    );
    const shortcutChrome = await readFile(
      new URL("../theme/zen-theme/v1/chrome/zen-shortcut-chrome.tsx", import.meta.url),
      "utf8",
    );
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
    expect(entry).toContain("MissionControlPage");
    expect(entry).toContain('surfaceId="surface.mission-control"');
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
    expect(shell).not.toContain("WORKSPACE_SURFACES.map");
    expect(shell).toContain("loadOwnPresentationNavigation");
    expect(shell).toContain("ZenShellChrome");
    expect(shellChrome).toContain("type ZenChromeLayer");
    expect(shellChrome).toContain("ZenNavigationChrome");
    expect(shellChrome).toContain("UserSystemControl");
    expect(shellChrome).toContain("resolveZenResponsiveChrome");
    expect(shellChrome).toContain("ZenShortcutChrome");
    expect(shortcutChrome).toContain("Universal shortcuts");
    expect(shortcutChrome).toContain("zen-shortcut-contextual");
    expect(shortcutChrome).toContain("resolveZenShortcutVisibleItemCount");
    expect(shortcutChrome).not.toContain("/workspace/my-work");
    expect(shortcutChrome).not.toContain("/workspace/tasks");
    expect(navigation).toContain('semanticKey="modules"');
    expect(navigation).toContain('semanticKey="menu"');
    expect(navigation).toContain("model.contextualMenu.destinations.map");
    expect(navigation).toContain("model.serviceGroups.map");
    expect(navigation).toContain('data-tooltip="Mission Control"');
    expect(navigation).toContain('data-tooltip="Service Groups"');
    expect(systemControl).toContain('semanticKey="user"');
    expect(systemControl).toContain('data-tooltip="User and system"');
    expect(systemControl).toContain("data-tooltip={`Close ");
    expect(systemControl).toContain("label.toLowerCase()");
    expect(shell).not.toContain("statusLabel: string");
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
    const [page, face, loading, error, notFound] = await Promise.all(
      [
        "page.tsx",
        "leave-request-detail-face.tsx",
        "loading.tsx",
        "error.tsx",
        "not-found.tsx",
      ].map(async (file) => await readFile(new URL(file, detailRoot), "utf8")),
    );
    expect(page).toContain("HrLeaveRequestDetailFace");
    expect(face).toContain("Evidence history");
    expect(face).toContain("Request details");
    expect(face).not.toContain("<form");
    expect(face).not.toContain("/approve");
    expect(face).not.toContain("/reject");
    expect(loading).toContain('aria-busy="true"');
    expect(error).toContain('role="alert"');
    expect(notFound).toContain("Leave request not found");
  });
});
