import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  buildHrLeaveDetailHref,
  getHrLeaveReturnLink,
  HR_LEAVE_CANONICAL_HOST_LINK,
  parseHrLeaveReturnContext,
} from "./hr-leave-navigation-core";

const leaveRequestId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

describe("HR leave closed navigation", () => {
  it("parses and maps only the four exact scalar return contexts", () => {
    expect(parseHrLeaveReturnContext("leave-list")).toBe("leave-list");
    expect(parseHrLeaveReturnContext("my-work")).toBe("my-work");
    expect(parseHrLeaveReturnContext("mission-control")).toBe("mission-control");
    expect(parseHrLeaveReturnContext("hr-mission-control")).toBe("hr-mission-control");
    expect(getHrLeaveReturnLink("leave-list")).toEqual({
      href: "/workspace/hr/leave",
      label: "Back to My Leave Requests",
    });
    expect(HR_LEAVE_CANONICAL_HOST_LINK).toEqual({
      href: "/workspace/hr/leave",
      label: "Back to My Leave Requests",
    });
    expect(getHrLeaveReturnLink("my-work")).toEqual({
      href: "/workspace/my-work",
      label: "Back to My Work",
    });
    expect(getHrLeaveReturnLink("mission-control")).toEqual({
      href: "/",
      label: "Back to Mission Control",
    });
    expect(getHrLeaveReturnLink("hr-mission-control")).toEqual({
      href: "/workspace/hr",
      label: "Back to HR Mission Control",
    });
  });

  it("rejects missing, repeated, unknown, path-like and URL-like contexts plus invalid IDs", () => {
    for (const value of [
      undefined,
      ["leave-list"],
      ["leave-list", "my-work"],
      "",
      "Leave-list",
      "my-work/../leave",
      "/workspace/my-work",
      "https://attacker.example",
      "//attacker.example",
    ]) {
      const parsed = parseHrLeaveReturnContext(value);
      expect(parsed).toBeUndefined();
      expect(getHrLeaveReturnLink(parsed)).toBeUndefined();
    }
    expect(() => buildHrLeaveDetailHref("bad", "leave-list")).toThrow(
      "Leave request ID is invalid",
    );
    expect(() => buildHrLeaveDetailHref("https://attacker.example", "my-work")).toThrow(
      "Leave request ID is invalid",
    );
    expect(() =>
      buildHrLeaveDetailHref(leaveRequestId, "https://attacker.example" as "my-work"),
    ).toThrow("Leave return context is invalid");
  });

  it("builds UUID-only detail hrefs with a closed context", () => {
    expect(buildHrLeaveDetailHref(leaveRequestId, "leave-list")).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=leave-list`,
    );
    expect(buildHrLeaveDetailHref(leaveRequestId, "my-work")).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=my-work`,
    );
    expect(
      buildHrLeaveDetailHref(
        leaveRequestId,
        "mission-control",
        `mission-control.my-leave.${leaveRequestId}`,
      ),
    ).toBe(
      `/workspace/hr/leave/${leaveRequestId}?returnContext=mission-control&originFocusId=mission-control.my-leave.${leaveRequestId}`,
    );
  });

  it("provides source-only wiring checks for five entrypoints and dead flags", async () => {
    const [list, form, detail, detailFace, myWork, approval, rejection] = await Promise.all(
      [
        "../app/workspace/hr/leave/page.tsx",
        "../app/workspace/hr/leave/new/leave-request-form.tsx",
        "../app/workspace/hr/leave/[leaveRequestId]/page.tsx",
        "../app/workspace/hr/leave/[leaveRequestId]/leave-request-detail-face.tsx",
        "../app/workspace/my-work/page.tsx",
        "../app/workspace/my-work/leave-approval-action.tsx",
        "../app/workspace/my-work/leave-rejection-action.tsx",
      ].map(async (path) => await readFile(new URL(path, import.meta.url), "utf8")),
    );

    expect(form).toContain('buildHrLeaveDetailHref(result.leaveRequestId, "leave-list")');
    expect(form).toContain("decodeHrLeaveSubmitTransport(");
    expect(form).toContain("router.replace(");
    expect(form).not.toContain("parseHrLeaveSubmitTransport");
    expect(list).toContain('buildHrLeaveDetailHref(request.leaveRequestId, "leave-list")');
    expect(list).toContain("View details");
    expect(myWork).toContain('buildHrLeaveDetailHref(item.leaveRequestId, "my-work")');
    expect(approval).toContain('buildHrLeaveDetailHref(result.leaveRequestId, "my-work")');
    expect(rejection).toContain('buildHrLeaveDetailHref(result.leaveRequestId, "my-work")');
    expect(detail).toContain("parseHrLeaveReturnContext(parameters.returnContext)");
    expect(detail).toContain("getHrLeaveReturnLink(returnContext)");
    expect(detail).toContain("HrLeaveRequestDetailFace");
    expect(detailFace).toContain("Evidence history");

    for (const source of [list, form, detail, detailFace, myWork, approval, rejection]) {
      expect(source).not.toMatch(/submitted=1|approved=1|rejected=1|returnTo|document\.referrer/);
    }
  });
});
