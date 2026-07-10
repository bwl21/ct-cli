/**
 * Normalizer for dynamic-group rulesets. CT returns rulesets with cosmetic
 * labels, inconsistent int/string leaf types, and read-only timestamps,
 * wrapped in a single-element `[RuleSet]` array. `PUT` expects the SAME
 * `[RuleSet]` array envelope back (see `putRulesetBody` below) — CT 3.134.1
 * 500s (`TypeException: Array expected`) on a bare object (#77). Normalizing
 * both the desired and actual sides to one canonical form is what keeps
 * drift real, not spurious.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

/**
 * Coerce numeric-string leaves to numbers (CT is int/string-inconsistent for `var` values).
 *
 * Only *canonical* integer strings are coerced: no leading zeros (`/^(-?[1-9]\d*|0)$/`) and
 * within `Number.MAX_SAFE_INTEGER`. This leaves semantic strings that merely look numeric —
 * leading-zero zip codes like `'01067'`, and >2^53 digit strings that would lose precision —
 * untouched, so they round-trip byte-identical through normalize + write-back instead of being
 * silently retyped (which broke their JSONLogic string comparisons). A canonical `"5"` still
 * coerces to `5`, so a `5` vs `"5"` int/string pair still diffs equal.
 */
export function coerceScalars(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(coerceScalars);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = coerceScalars(v);
    return out;
  }
  if (typeof node === "string" && /^(-?[1-9]\d*|0)$/.test(node)) {
    const n = Number.parseInt(node, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return node;
}

function dropReadOnly(rule: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rule)) if (!READ_ONLY_KEYS.has(k)) out[k] = v;
  return out;
}

/** Canonicalise a ruleset for diffing: unwrap array/PUT envelope, drop timestamps; strip labels + coerce scalars WITHIN the query subtree only. */
export function normalizeRuleset(rule: unknown): Record<string, unknown> {
  let r: unknown = rule ?? {};
  if (Array.isArray(r)) r = r[0] ?? {};                       // GET returns a single-element [RuleSet]
  let obj = (r ?? {}) as Record<string, unknown>;
  if (obj.dynamicGroupRuleSet && typeof obj.dynamicGroupRuleSet === "object") {
    // Defensive: tolerate a legacy/foreign `{ dynamicGroupRuleSet }` object envelope if one is ever
    // fed through here. CT's actual envelope (both GET and PUT) is the `[RuleSet]` array handled
    // above, not this wrapper — see `putRulesetBody`.
    obj = obj.dynamicGroupRuleSet as Record<string, unknown>;
  }
  const base = dropReadOnly(obj);
  // Cosmetic dterm labels and int/string id inconsistencies live inside `query`. Normalize only
  // that subtree, so a RuleSet-level string field that looks numeric (a "2024" description/shorty)
  // is never silently retyped to a number and corrupted on write-back.
  if (base.query !== undefined) {
    base.query = coerceScalars(stripCosmeticLabels(base.query));
  }
  return base;
}

/**
 * The body `PUT /dynamicgroups/{id}/ruleset` expects: an OBJECT wrapper whose
 * `dynamicGroupRuleSet` property is a single-element array. Decoded from CT 3.134.1's own
 * validator, live (#77): `{ dynamicGroupRuleSet: RuleSet }` → "Array expected ... at
 * #->properties:dynamicGroupRuleSet"; a bare `[RuleSet]` → "Object expected, [...] received"
 * at the root. Together: root = object, property = array → `{ dynamicGroupRuleSet: [RuleSet] }`.
 * (GET, by contrast, returns the bare `[RuleSet]` array.)
 * The single source of truth for the PUT envelope — every writer (apply path, live-gated tests)
 * must go through this so the envelope can't drift out of sync again.
 */
export function putRulesetBody(
  ruleset: Record<string, unknown>,
): { dynamicGroupRuleSet: [Record<string, unknown>] } {
  return { dynamicGroupRuleSet: [ruleset] };
}

export interface NormalizedDynamic { status: DynamicStatus; ruleset: Record<string, unknown> }

export function normalizeDynamic(spec: { status: DynamicStatus; ruleset: unknown }): NormalizedDynamic {
  return { status: spec.status, ruleset: normalizeRuleset(spec.ruleset) };
}

/**
 * Resolve a `{ ref: "./file.json" }` ruleset to its JSON contents; pass through inline rulesets.
 * `ref` paths resolve relative to `baseDir` (the config file's directory), NOT the process cwd,
 * so a config is portable regardless of where `ct` is invoked. Missing/unreadable/invalid-JSON
 * ref files raise a clear error naming the group and the resolved path instead of a raw ENOENT.
 */
export function resolveRulesetRef(ruleset: unknown, baseDir: string = process.cwd(), groupKey?: string): unknown {
  if (ruleset && typeof ruleset === "object" && typeof (ruleset as { ref?: unknown }).ref === "string") {
    const ref = (ruleset as { ref: string }).ref;
    const p = resolve(baseDir, ref);
    const where = groupKey ? `dynamic ruleset for group "${groupKey}"` : "dynamic ruleset";
    let raw: string;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      throw new Error(`${where}: cannot read ruleset ref "${ref}" (resolved to ${p}): ${(err as Error).message}`);
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`${where}: ruleset ref "${ref}" (resolved to ${p}) is not valid JSON: ${(err as Error).message}`);
    }
  }
  return ruleset;
}
