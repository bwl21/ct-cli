/**
 * Normalizer for dynamic-group rulesets. CT returns rulesets with cosmetic
 * labels, inconsistent int/string leaf types, read-only timestamps, and (on
 * write) a `dynamicGroupRuleSet` envelope. Normalizing both the desired and
 * actual sides to one canonical form is what keeps drift real, not spurious.
 */
import type { DynamicStatus } from "./types.js";

const READ_ONLY_KEYS = new Set(["dynamicGroupUpdateStarted", "dynamicGroupUpdateFinished"]);

/** Recursively unwrap `dterm: [label, expr]` cosmetic wrappers to their `expr`. */
export function stripCosmeticLabels(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripCosmeticLabels);
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.dterm) && obj.dterm.length === 2 && Object.keys(obj).length === 1) {
      return stripCosmeticLabels(obj.dterm[1]); // keep the expression, drop the label
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = stripCosmeticLabels(v);
    return out;
  }
  return node;
}

/** Coerce numeric-string leaves to numbers (CT is int/string-inconsistent for `var` values). */
export function coerceScalars(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(coerceScalars);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = coerceScalars(v);
    return out;
  }
  if (typeof node === "string" && /^-?\d+$/.test(node)) return Number.parseInt(node, 10);
  return node;
}

function dropReadOnly(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) if (!READ_ONLY_KEYS.has(k)) out[k] = v;
  return out;
}

/** Canonicalise a ruleset for diffing: unwrap array/PUT envelope, drop timestamps, strip labels, coerce scalars. */
export function normalizeRuleset(rule: unknown): Record<string, unknown> {
  let r: unknown = rule ?? {};
  if (Array.isArray(r)) r = r[0] ?? {};                       // GET returns a single-element [RuleSet]
  let obj = (r ?? {}) as Record<string, unknown>;
  if (obj.dynamicGroupRuleSet && typeof obj.dynamicGroupRuleSet === "object") {
    obj = obj.dynamicGroupRuleSet as Record<string, unknown>; // unwrap the PUT envelope
  }
  return coerceScalars(stripCosmeticLabels(dropReadOnly(obj))) as Record<string, unknown>;
}

export interface NormalizedDynamic { status: DynamicStatus; ruleset: Record<string, unknown> }

export function normalizeDynamic(spec: { status: DynamicStatus; ruleset: unknown }): NormalizedDynamic {
  return { status: spec.status, ruleset: normalizeRuleset(spec.ruleset) };
}
