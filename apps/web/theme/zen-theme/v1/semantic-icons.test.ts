import { describe, expect, it } from "vitest";
import { resolveSemanticIcon } from "./semantic-icons";

describe("Zen semantic icon registry", () => {
  it("resolves a registered widget icon and uses only the declared generic fallback", () => {
    const leave = resolveSemanticIcon("calendar-check");
    const fallback = resolveSemanticIcon("generic-service");
    expect(leave).not.toBe(fallback);
    expect(resolveSemanticIcon("arbitrary-package-icon")).toBe(fallback);
    expect(resolveSemanticIcon(undefined)).toBe(fallback);
  });
});
