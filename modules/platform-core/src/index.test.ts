import { describe, expect, it } from "vitest";
import type { TenantTransaction } from "./context.js";
import { evaluatePolicy, platformCoreManifest } from "./index.js";

const policyTransaction = {
  actor: { principalId: "actor", roleKey: "manager" },
  context: {
    actorPrincipalId: "actor",
    correlationId: "correlation",
    tenantId: "tenant",
  },
} as TenantTransaction;

describe("platformCoreManifest", () => {
  it("is the required root module", () => {
    expect(platformCoreManifest.activation).toBe("required");
    expect(platformCoreManifest.dependencies).toEqual([]);
    expect(platformCoreManifest.capabilities).toContainEqual({
      exposure: "internal",
      id: "platform.policy.evaluate",
    });
  });

  it("denies by default and gives explicit deny precedence", () => {
    const evaluation = {
      actionKey: "test.read",
      input: {},
      resourceKey: "test-resource",
      transaction: policyTransaction,
    };
    expect(evaluatePolicy(evaluation, [])).toMatchObject({
      effect: "deny",
      reason: "no_applicable_allow_rule",
    });
    expect(
      evaluatePolicy(evaluation, [
        { effect: "allow", id: "allow-manager", matches: () => true },
        { effect: "deny", id: "deny-self", matches: () => true },
      ]),
    ).toMatchObject({ effect: "deny", matchedRuleIds: ["deny-self"] });
  });

  it("fails closed when policy evaluation throws", () => {
    const decision = evaluatePolicy(
      {
        actionKey: "test.read",
        input: {},
        resourceKey: "test-resource",
        transaction: policyTransaction,
      },
      [
        {
          effect: "allow",
          id: "broken-rule",
          matches: () => {
            throw new Error("bad rule");
          },
        },
      ],
    );
    expect(decision).toMatchObject({
      effect: "deny",
      matchedRuleIds: ["broken-rule"],
      reason: "rule_evaluation_failed",
    });
  });
});
