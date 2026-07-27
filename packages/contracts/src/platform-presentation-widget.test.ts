import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizePresentationWidgetDefinition,
  HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
  parsePresentationSemanticIconKey,
  parsePresentationWidgetDefinition,
  presentationSemanticIconKeys,
} from "./platform-presentation-widget.js";

describe("presentation widget manifest", () => {
  it("binds the complete immutable Leave definition to its startup hash", () => {
    const { canonicalHash, ...manifest } = HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION;
    expect(canonicalHash).toBe("2f3b5ac4d9196da275d6837b8fae40485c28bce9900a9ae58bae7e2fda5c8e22");
    expect(
      createHash("sha256").update(canonicalizePresentationWidgetDefinition(manifest)).digest("hex"),
    ).toBe(canonicalHash);
    expect(parsePresentationWidgetDefinition(HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION)).toBe(
      HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
    );
  });

  it("rejects definition drift and executable manifest extensions", () => {
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        executableImport: "private/widget.js",
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        requiredCapabilityIds: ["hr.leave.list_own"],
      }),
    ).toThrow("Invalid presentation widget definition");
    expect(() =>
      parsePresentationWidgetDefinition({
        ...HR_LEAVE_MY_REQUESTS_WIDGET_DEFINITION,
        semanticIcon: "arbitrary-svg",
      }),
    ).toThrow("Invalid presentation widget definition");
  });

  it("accepts only the code-owned semantic icon registry and declares one fallback", () => {
    expect(presentationSemanticIconKeys).toContain("modules");
    expect(presentationSemanticIconKeys).toContain("menu");
    expect(presentationSemanticIconKeys).toContain("calendar-check");
    expect(presentationSemanticIconKeys).toContain("generic-service");
    expect(presentationSemanticIconKeys).not.toContain("service-groups");
    expect(presentationSemanticIconKeys).not.toContain("page-menu");
    expect(parsePresentationSemanticIconKey("calendar-check")).toBe("calendar-check");
    expect(() => parsePresentationSemanticIconKey("package/private-icon")).toThrow(
      "Invalid presentation semantic icon",
    );
  });
});
