import type { TenantActor, TenantTransaction } from "./context.js";
import { PlatformError } from "./errors.js";

export type PolicyEffect = "allow" | "deny";

export interface PolicyRule<Input> {
  readonly effect: PolicyEffect;
  readonly id: string;
  readonly matches: (input: Input, actor: TenantActor) => boolean;
}

export interface PolicyEvaluation<Input> {
  readonly actionKey: string;
  readonly input: Input;
  readonly resourceKey: string;
  readonly transaction: TenantTransaction;
}

export interface PolicyDecision {
  readonly actionKey: string;
  readonly actorPrincipalId: string;
  readonly effect: PolicyEffect;
  readonly matchedRuleIds: readonly string[];
  readonly reason: string;
  readonly resourceKey: string;
  readonly tenantId: string;
}

const issuedDecisions = new WeakMap<object, TenantTransaction>();

function issueDecision(
  evaluation: PolicyEvaluation<unknown>,
  result: Pick<PolicyDecision, "effect" | "matchedRuleIds" | "reason">,
): PolicyDecision {
  const decision = Object.freeze({
    actionKey: evaluation.actionKey,
    actorPrincipalId: evaluation.transaction.actor.principalId,
    resourceKey: evaluation.resourceKey,
    tenantId: evaluation.transaction.context.tenantId,
    ...result,
  });
  issuedDecisions.set(decision, evaluation.transaction);
  return decision;
}

export function evaluatePolicy<Input>(
  evaluation: PolicyEvaluation<Input>,
  rules: readonly PolicyRule<Input>[],
): PolicyDecision {
  const matching: PolicyRule<Input>[] = [];

  for (const rule of rules) {
    try {
      if (rule.matches(evaluation.input, evaluation.transaction.actor)) {
        matching.push(rule);
      }
    } catch {
      return issueDecision(evaluation, {
        effect: "deny",
        matchedRuleIds: [rule.id],
        reason: "rule_evaluation_failed",
      });
    }
  }

  const denyRules = matching.filter((rule) => rule.effect === "deny");
  if (denyRules.length > 0) {
    return issueDecision(evaluation, {
      effect: "deny",
      matchedRuleIds: denyRules.map((rule) => rule.id),
      reason: "explicit_deny",
    });
  }

  const allowRules = matching.filter((rule) => rule.effect === "allow");
  if (allowRules.length > 0) {
    return issueDecision(evaluation, {
      effect: "allow",
      matchedRuleIds: allowRules.map((rule) => rule.id),
      reason: "explicit_allow",
    });
  }

  return issueDecision(evaluation, {
    effect: "deny",
    matchedRuleIds: [],
    reason: "no_applicable_allow_rule",
  });
}

export function assertPolicyAllowed(
  decision: PolicyDecision,
  transaction: TenantTransaction,
  actionKey: string,
  resourceKey: string,
): void {
  const bound =
    issuedDecisions.get(decision) === transaction &&
    decision.actorPrincipalId === transaction.context.actorPrincipalId &&
    decision.tenantId === transaction.context.tenantId &&
    decision.actionKey === actionKey &&
    decision.resourceKey === resourceKey;
  if (!bound || decision.effect !== "allow") {
    throw new PlatformError("POLICY_DENIED", "Policy decision denied the action", {
      bound,
      matchedRuleIds: decision.matchedRuleIds,
      reason: decision.reason,
    });
  }
}
