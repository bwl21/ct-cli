# Auto-groups (Dynamic Groups) Implementation Plan — Issue #14

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage ChurchTools dynamic groups (ruleset + status) as declarative code via an opt-in `dynamic` block on a group, with drift detection, idempotent apply, and a typed query builder.

**Architecture:** A dynamic group is an ordinary group whose `settings` carry a ruleset + status — there is no separate entity and no create endpoint. We model it as an opt-in **object pseudo-field** (`dynamic`) on a group, mirroring the existing `parents` set-field: folded into the diff on both sides in `build.ts` (via a new generic synthetic-field seam), and routed at apply time to the dedicated `/dynamicgroups/{id}/ruleset` + `/status` endpoints instead of the group body. A normalizer strips cosmetic labels and coerces representational differences so drift is real, not spurious.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), Vitest, existing `CtClient`.

## Global Constraints

- Node ≥ 20; repo pins 22 via `.nvmrc`.
- ESM with NodeNext: **all relative imports use `.js` specifiers** even from `.ts` sources.
- Dependencies are minimal (`commander`, `jiti`, `openapi-fetch`, `picocolors`) — **add no new runtime dependency** without calling it out.
- People are never managed: every new write path must pass through `assertNotPeople` (`src/engine/guard.ts`).
- Managed-guard: only resources declared in config or present in the state file are ever diffed/written; everything else stays invisible.
- CT ids can be `0` — never use truthiness on an id; use explicit null/undefined checks.
- Tests mirror `tests/*.test.ts`, import from `../src/**/*.js`, use `describe/it/expect`.
- Live instance for integration/fixtures: `eqrm-dev.church.tools` (write-safe dev box, CT 3.134.1-RC1). Integration tests that write are **opt-in, gated behind `CT_LIVE=1`**, and must clean up after themselves.

## Authoritative API shapes (from the live OpenAPI, 2026-07-08)

- `GET /dynamicgroups` → `int[]` (ids of dynamic groups).
- `GET /dynamicgroups/{id}/ruleset` → `{ data: RuleSet }` (**bare**).
- `PUT /dynamicgroups/{id}/ruleset` → body **wrapped**: `{ dynamicGroupRuleSet: RuleSet }`. Response echoes `{ data: RuleSet }`.
- `DELETE /dynamicgroups/{id}/ruleset` → `204` (demote to normal group).
- `GET /dynamicgroups/{id}/status` → `{ dynamicGroupStatus: "active"|"inactive"|"manual"|"none" }`.
- `PUT /dynamicgroups/{id}/status` → body `{ dynamicGroupStatus: string }`.
- `POST /dynamicgroups/{id}/refresh` → `{ data: [{ groupId, created, updated, deleted, unprocessed }] }` (per-group; **never** call `/dynamicgroups/refresh`, the all-groups variant).
- `RuleSet = { description, importance, personIdFieldName, process, query, shorty? }`.
  - `query` is a **ChurchQuery envelope**: `{ description, method: "ChurchQuery", params: { filter: {…JSONLogic…}, responseFields, orderBy, … } }`. The JSONLogic tree lives inside the opaque `params.filter`.
  - `process` is a `{ groupOnly, groupAndQueryResult, queryResultOnly }` set, each mapping a member status (`active|none|requested|to_delete|waiting`) → `{ handleMembership: {…} }`. `handleMembership` contents are opaque in OpenAPI → captured live in Task 1.
  - Read-only timestamps `dynamicGroupUpdateStarted` / `dynamicGroupUpdateFinished` may appear on the group's `settings`; they always drift and must be ignored.

**Note on `CtClient.request`:** it unwraps a `{ data }` envelope automatically (returns `parsed.data ?? parsed`). So `client.get("/dynamicgroups/5/ruleset")` returns the bare `RuleSet`, and `client.get("/dynamicgroups/5/status")` returns `{ dynamicGroupStatus }` (no `data` wrapper on that endpoint). Verify per-endpoint in Task 1 and rely on the captured fixtures.

---

## Task 1: Capture live fixtures for a real dynamic group

**Files:**

- Create: `tests/fixtures/dynamic/ruleset.get.json` (bare `RuleSet` as returned by GET)
- Create: `tests/fixtures/dynamic/status.get.json` (`{ dynamicGroupStatus }`)
- Create: `tests/fixtures/dynamic/README.md` (how the fixture was produced + the group id used, so it is reproducible)

**Interfaces:**

- Produces: canonical example `RuleSet` + status JSON consumed by Tasks 4, 5, 7 (normalizer, synthetic-field, typed-query). All later normalizer code is validated against these files.

**Why a task:** the `query.params.filter` JSONLogic internals and `handleMembership` contents are opaque in OpenAPI. The only way to write a correct normalizer + typed-query compiler is against real rulesets.

**STATUS: COMPLETE** — captured by the controller **read-only** from the production instance `eqrm.church.tools` (CT 3.134.0), which has 68 real dynamic groups. Committed fixtures: `tests/fixtures/dynamic/ruleset-683.get.json` (string + object `dterm` labels, nested `or`/`and`/`!`, `oneof` string arrays, `isnull`, `"true and"`), `ruleset-2022.get.json` (`isnull`, `subgroups`, `campusId`, `groupMemberStatus`, mixed int/string), `ruleset-1092.get.json`, `ruleset.get.json` (canonical = 683), `status.get.json`, and `README.md` documenting the shapes.

**The one shape correction downstream tasks depend on:** `GET /dynamicgroups/{id}/ruleset` returns a **single-element array `[RuleSet]`**, not the bare object the OpenAPI schema advertised. `normalizeRuleset` (Task 4) unwraps it. See `tests/fixtures/dynamic/README.md` for the full shape notes.

---

## Task 2: Generic synthetic-field seam; migrate `parents` into it

**Files:**

- Create: `src/engine/synthetic.ts`
- Modify: `src/engine/build.ts` (replace the inline hierarchy fold with the registry)
- Modify: `src/engine/execute.ts` (route synthetic-field writes through the registry)
- Test: `tests/synthetic.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface SyntheticFoldCtx {
    client: Pick<CtClient, "get">;
    state: State;
    desired: DesiredResource[];
    actual: Map<string, Record<string, unknown>>;
  }
  export interface SyntheticApplyCtx {
    client: Pick<CtClient, "request">;
    state: State;
    id: number; // CT id of the owning resource just created/updated
    change: FieldChange; // the change whose `field` === this.field
  }
  export interface SyntheticField {
    field: string; // pseudo-field name, e.g. "parents", "dynamic"
    fold(ctx: SyntheticFoldCtx): Promise<{ desired: DesiredResource[]; errors: string[] }>;
    apply(ctx: SyntheticApplyCtx): Promise<void>;
  }
  export const SYNTHETIC_FIELDS: SyntheticField[]; // registry; parents first
  export function isSyntheticField(field: string): boolean;
  export async function foldSynthetic(
    ctx: SyntheticFoldCtx,
  ): Promise<{ desired: DesiredResource[]; errors: string[] }>;
  ```
- Consumes: existing `applyHierarchy`, `parentIdsByGroupId`, `HierarchyEntry` (from `hierarchy.ts`); existing `applyParentEdges` logic (moved/wrapped).

- [ ] **Step 1: Write the failing test**

`tests/synthetic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isSyntheticField, SYNTHETIC_FIELDS, foldSynthetic } from "../src/engine/synthetic.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

describe("synthetic-field registry", () => {
  it("recognises registered pseudo-fields and nothing else", () => {
    expect(isSyntheticField("parents")).toBe(true);
    expect(SYNTHETIC_FIELDS.some((f) => f.field === "parents")).toBe(true);
    expect(isSyntheticField("name")).toBe(false);
  });

  it("parents fold folds managed hierarchy into desired + actual", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        child: {
          type: "group",
          id: 1311,
          key: "child",
          fields: { name: "child" },
          adoptedAt: "t",
          updatedAt: "t",
        },
        parent: {
          type: "group",
          id: 8,
          key: "parent",
          fields: { name: "parent" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([
      ["child", { name: "child" }],
      ["parent", { name: "parent" }],
    ]);
    const desired: DesiredResource[] = [
      { type: "group", key: "child", fields: { name: "child" }, parents: ["parent"], dependsOn: ["parent"] },
      { type: "group", key: "parent", fields: { name: "parent" }, dependsOn: [] },
    ];
    const client = {
      get: async () => [
        { groupId: 1311, parents: [8], children: [] },
        { groupId: 8, children: [1311] },
      ],
    };
    const out = await foldSynthetic({ client, state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("child")?.parents).toEqual(["parent"]);
    expect(out.desired[0]?.fields.parents).toEqual(["parent"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/synthetic.test.ts`
Expected: FAIL — cannot find module `../src/engine/synthetic.js`.

- [ ] **Step 3: Implement `src/engine/synthetic.ts` with the parents entry**

```ts
/**
 * Generic seam for "synthetic sub-resource fields": pseudo-fields that are not
 * real API columns on a resource (like `parents`), but are folded into the diff
 * on both sides and routed at apply time to a dedicated endpoint. `parents` is
 * the first entry; dynamic groups (and later permission grants) join the same
 * registry so `build.ts`/`execute.ts` never grow per-feature branches.
 */
import type { CtClient } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, FieldChange } from "./types.js";
import { applyHierarchy, parentIdsByGroupId, type HierarchyEntry } from "./hierarchy.js";
import { assertNotPeople } from "./guard.js";

export interface SyntheticFoldCtx {
  client: Pick<CtClient, "get">;
  state: State;
  desired: DesiredResource[];
  actual: Map<string, Record<string, unknown>>;
}
export interface SyntheticApplyCtx {
  client: Pick<CtClient, "request">;
  state: State;
  id: number;
  change: FieldChange;
}
export interface SyntheticField {
  field: string;
  fold(ctx: SyntheticFoldCtx): Promise<{ desired: DesiredResource[]; errors: string[] }>;
  apply(ctx: SyntheticApplyCtx): Promise<void>;
}

function resolveId(state: State, key: string): number {
  const managed = state.resources[key];
  if (!managed) throw new Error(`Cannot resolve parent "${key}" — not under management yet.`);
  return managed.id;
}

/** `parents`: many-to-many group hierarchy, reconciled per-edge. Wraps the existing hierarchy helpers. */
const parentsField: SyntheticField = {
  field: "parents",
  async fold({ client, state, desired, actual }) {
    const hasManagedGroups = Object.values(state.resources).some((m) => m.type === "group");
    if (!hasManagedGroups) return { desired, errors: [] };
    try {
      const raw = await client.get<HierarchyEntry[]>("/groups/hierarchies");
      const parentIds = parentIdsByGroupId(Array.isArray(raw) ? raw : []);
      return { desired: applyHierarchy(desired, state, actual, parentIds), errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Leave `parents` undiffed rather than fabricate "add all parents" from an empty map.
      return { desired, errors: [`group hierarchies: ${message}`] };
    }
  },
  async apply({ client, state, id, change }) {
    const from = new Set(Array.isArray(change.from) ? (change.from as string[]) : []);
    const to = new Set(Array.isArray(change.to) ? (change.to as string[]) : []);
    for (const key of [...to].filter((k) => !from.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("PUT", path);
    }
    for (const key of [...from].filter((k) => !to.has(k))) {
      const path = `/groups/${id}/parents/${resolveId(state, key)}`;
      assertNotPeople(path);
      await client.request("DELETE", path);
    }
  },
};

export const SYNTHETIC_FIELDS: SyntheticField[] = [parentsField];

const BY_FIELD = new Map(SYNTHETIC_FIELDS.map((f) => [f.field, f]));
export function isSyntheticField(field: string): boolean {
  return BY_FIELD.has(field);
}
export function syntheticField(field: string): SyntheticField | undefined {
  return BY_FIELD.get(field);
}

/** Run every registered fold in order, threading the (immutably) augmented desired through each. */
export async function foldSynthetic(
  ctx: SyntheticFoldCtx,
): Promise<{ desired: DesiredResource[]; errors: string[] }> {
  let desired = ctx.desired;
  const errors: string[] = [];
  for (const f of SYNTHETIC_FIELDS) {
    const res = await f.fold({ ...ctx, desired });
    desired = res.desired;
    errors.push(...res.errors);
  }
  return { desired, errors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/synthetic.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire `build.ts` to use `foldSynthetic`**

In `src/engine/build.ts`, replace the hierarchy block (the `let parentIds` / `hasManagedGroups` / `applyHierarchy` section, lines ~59-76) with:

```ts
// Synthetic sub-resource fields (parents, dynamic, …) fold into the diff on both sides.
const folded = await foldSynthetic({ client, state, desired, actual });
fetchErrors.push(...folded.errors);
const plan = computePlan(folded.desired, state, actual, { unresolved });
```

Update imports: remove `applyHierarchy`, `parentIdsByGroupId`, `HierarchyEntry`, and add `import { foldSynthetic } from "./synthetic.js";`. Delete the now-unused `desiredWithHierarchy`/`hierarchyOk` locals.

- [ ] **Step 6: Rewire `execute.ts` to route synthetic writes through the registry**

In `src/engine/execute.ts`:

- Replace `applyParentEdges(...)` calls (in both the create and update branches) with a generic `applySyntheticFields(client, state, id, item.changes)`.
- Add the helper and update `snapshotFromChanges` to drop **all** synthetic fields, not just `parents`:

```ts
import { isSyntheticField, syntheticField } from "./synthetic.js";

function snapshotFromChanges(base: Record<string, unknown>, changes: FieldChange[]): Record<string, unknown> {
  const snap = { ...base };
  for (const c of changes) if (!isSyntheticField(c.field)) snap[c.field] = c.to;
  for (const f of Object.keys(snap)) if (isSyntheticField(f)) delete snap[f];
  return snap;
}

async function applySyntheticFields(
  client: Pick<CtClient, "request">,
  state: State,
  id: number,
  changes: FieldChange[],
): Promise<void> {
  for (const c of changes) {
    const f = syntheticField(c.field);
    if (f) await f.apply({ client, state, id, change: c });
  }
}
```

Also update `hasFieldChange` in the update branch to `item.changes.some((c) => !isSyntheticField(c.field))` so a change touching only synthetic fields still skips the body PATCH. Remove the old `parentEdges`/`resolveId`/`applyParentEdges` functions.

- [ ] **Step 7: Run the full suite to verify the refactor is behavior-preserving**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — existing `tests/hierarchy.test.ts`, `tests/execute.test.ts`, `tests/build.test.ts` still green (parents behavior unchanged).

- [ ] **Step 8: Commit**

```bash
git add src/engine/synthetic.ts src/engine/build.ts src/engine/execute.ts tests/synthetic.test.ts
git commit -m "refactor(engine): generic synthetic-field seam; migrate parents into it"
```

---

## Task 3: Accept and validate the `dynamic` block in the config DSL

**Files:**

- Modify: `src/config/context.ts` (add `dynamic` handling to `toDesired` + validation)
- Modify: `src/engine/types.ts` (add `dynamic?` to `DesiredResource`, define `DynamicSpec`)
- Test: `tests/context.test.ts` (extend)

**Interfaces:**

- Produces:
  ```ts
  // types.ts
  export type DynamicStatus = "active" | "inactive" | "manual" | "none";
  export interface DynamicSpec {
    status: DynamicStatus;
    ruleset: unknown; // RuleSet object, or { ref: "./path.json" }, or a typed-query build result
  }
  // DesiredResource gains: dynamic?: DynamicSpec;
  ```
- Consumes: `ResourceInput` (already an index-signature bag), `toDesired`.

- [ ] **Step 1: Write the failing test** (append to `tests/context.test.ts`)

```ts
import { createContext } from "../src/config/context.js";

describe("dynamic block", () => {
  it("attaches a validated dynamic spec to the group and drops it from plain fields", async () => {
    const { ct, resources } = createContext();
    ct.group({
      key: "all_mainz",
      name: "Alle Mainz",
      groupTypeId: 1,
      dynamic: { status: "manual", ruleset: { description: "x", method: "ChurchQuery", params: {} } },
    });
    const g = resources.find((r) => r.key === "all_mainz")!;
    expect(g.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "x", method: "ChurchQuery", params: {} },
    });
    expect(g.fields).not.toHaveProperty("dynamic"); // never a plain diffed field
  });

  it("rejects an invalid status", async () => {
    const { ct } = createContext();
    expect(() =>
      ct.group({ key: "g", name: "G", dynamic: { status: "bogus", ruleset: {} } as never }),
    ).toThrow(/dynamic.*status/i);
  });

  it("rejects dynamic on a non-group", async () => {
    const { ct } = createContext();
    expect(() =>
      ct.campus({ key: "c", name: "C", dynamic: { status: "manual", ruleset: {} } } as never),
    ).toThrow(/dynamic.*only.*group/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL — `g.dynamic` undefined; no validation.

- [ ] **Step 3: Implement in `types.ts` and `context.ts`**

In `src/engine/types.ts` add the exports above and `dynamic?: DynamicSpec;` to `DesiredResource`.

In `src/config/context.ts`:

- Add `dynamic` to the destructure in `toDesired`: `const { key, parent, parents, dependsOn = [], preventDestroy, dynamic, ...fields } = input;`
- After the existing validation, add:

```ts
const DYNAMIC_STATUSES = ["active", "inactive", "manual", "none"] as const;
let dynamicSpec: DynamicSpec | undefined;
if (dynamic !== undefined) {
  if (type !== "group") throw new Error(`${type} "${key}": "dynamic" is only valid on a group.`);
  const d = dynamic as Record<string, unknown>;
  if (!DYNAMIC_STATUSES.includes(d.status as never))
    throw new Error(`group "${key}": "dynamic.status" must be one of ${DYNAMIC_STATUSES.join(", ")}.`);
  if (d.ruleset == null || typeof d.ruleset !== "object")
    throw new Error(`group "${key}": "dynamic.ruleset" must be a RuleSet object or a { ref } reference.`);
  dynamicSpec = { status: d.status as DynamicStatus, ruleset: d.ruleset };
}
```

- Return `dynamic: dynamicSpec` on the `DesiredResource` (add to the returned object). Import `DynamicSpec`, `DynamicStatus` from `../engine/types.js`.
- Keep `dynamic` out of `fields` (it is destructured out above — verify it is not spread back in).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/context.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/context.ts src/engine/types.ts tests/context.test.ts
git commit -m "feat(dynamic): accept and validate the dynamic block in the config DSL"
```

---

## Task 4: Ruleset normalizer

**Files:**

- Create: `src/engine/dynamic.ts` (normalizer + status helpers)
- Test: `tests/dynamic.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface NormalizedDynamic {
    status: DynamicStatus;
    ruleset: Record<string, unknown>;
  }
  export function normalizeRuleset(rule: unknown): Record<string, unknown>; // canonical form for diffing
  export function stripCosmeticLabels(node: unknown): unknown; // remove dterm [label, expr] wrappers
  export function coerceScalars(node: unknown): unknown; // int/string coercion of leaf values
  export function normalizeDynamic(spec: { status: DynamicStatus; ruleset: unknown }): NormalizedDynamic;
  ```
- Consumes: `DynamicStatus` from `types.js`; the fixtures from Task 1.

**Reference:** the golden inputs are the **real production fixtures** captured in Task 1 (`tests/fixtures/dynamic/ruleset*.get.json`) — see `tests/fixtures/dynamic/README.md`. Key realities they encode:

- **`GET …/ruleset` returns a single-element array `[RuleSet]`** — `normalizeRuleset` unwraps it (see code below).
- `dterm: [label, expr]` labels appear as **both** plain strings (`"Nur aktive Personen"`) and objects (`{ title, stereotype? }`, `title` possibly an i18n key). The stripper drops element 0 regardless of its shape and keeps `expr`.
- int/string inconsistency is pervasive (`1` vs `"1"`, `oneof [...["112","8"]]` vs `oneof [...[1]]`) — `coerceScalars` fixes it. Non-numeric strings (`"active"`, field names) are left alone.

- [ ] **Step 1: Write the failing test**

`tests/dynamic.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeRuleset,
  stripCosmeticLabels,
  coerceScalars,
  normalizeDynamic,
} from "../src/engine/dynamic.js";

describe("stripCosmeticLabels", () => {
  it("unwraps a dterm with a string label to its expr, recursively", () => {
    const input = { and: [{ dterm: ["Campus", { "==": [{ var: "ctgroup.campusId" }, 1] }] }] };
    expect(stripCosmeticLabels(input)).toEqual({ and: [{ "==": [{ var: "ctgroup.campusId" }, 1] }] });
  });
  it("unwraps a dterm with an object label (title/stereotype/i18n key)", () => {
    const input = {
      dterm: [
        { title: "group.x.title", stereotype: ["groupmembership"] },
        { isnull: [{ var: "person.dateOfDeath" }] },
      ],
    };
    expect(stripCosmeticLabels(input)).toEqual({ isnull: [{ var: "person.dateOfDeath" }] });
  });
});

describe("coerceScalars", () => {
  it("coerces numeric strings to numbers so int/string drift is not spurious", () => {
    expect(coerceScalars({ "==": [{ var: "ctgroup.campusId" }, "1"] })).toEqual({
      "==": [{ var: "ctgroup.campusId" }, 1],
    });
  });
  it("coerces numeric strings inside oneof arrays but leaves non-numeric strings", () => {
    expect(coerceScalars({ oneof: [{ var: "ctgroup.id" }, ["112", "8"]] })).toEqual({
      oneof: [{ var: "ctgroup.id" }, [112, 8]],
    });
    expect(coerceScalars({ "==": [{ var: "groupmember.groupMemberStatus" }, "active"] })).toEqual({
      "==": [{ var: "groupmember.groupMemberStatus" }, "active"],
    });
  });
});

describe("normalizeRuleset", () => {
  it("drops read-only timestamps and the PUT envelope, and is idempotent", () => {
    const withEnvelope = {
      dynamicGroupRuleSet: { description: "x", dynamicGroupUpdateStarted: "t", process: {}, query: {} },
    };
    const once = normalizeRuleset(withEnvelope);
    expect(once).not.toHaveProperty("dynamicGroupUpdateStarted");
    expect(once).not.toHaveProperty("dynamicGroupRuleSet");
    expect(normalizeRuleset(once)).toEqual(once); // idempotent: read→normalize→normalize == normalize
  });

  it("unwraps the single-element array that GET returns", () => {
    const arr = [{ description: "x", process: {}, query: {} }];
    expect(normalizeRuleset(arr)).toEqual(normalizeRuleset(arr[0]));
  });

  it("read-then-normalize of every live fixture is stable and label-free", () => {
    for (const name of ["ruleset-683", "ruleset-2022", "ruleset-1092"]) {
      const raw = JSON.parse(readFileSync(`tests/fixtures/dynamic/${name}.get.json`, "utf8")); // array shape
      const once = normalizeRuleset(raw);
      expect(normalizeRuleset(once)).toEqual(once); // idempotent
      expect(JSON.stringify(once)).not.toContain("dterm"); // cosmetic labels stripped
    }
  });
});

describe("normalizeDynamic", () => {
  it("normalizes status + ruleset together", () => {
    const out = normalizeDynamic({ status: "manual", ruleset: { description: "x", query: {}, process: {} } });
    expect(out.status).toBe("manual");
    expect(out.ruleset).toHaveProperty("description", "x");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/dynamic.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/engine/dynamic.ts`**

```ts
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
  if (Array.isArray(r)) r = r[0] ?? {}; // GET returns a single-element [RuleSet]
  let obj = (r ?? {}) as Record<string, unknown>;
  if (obj.dynamicGroupRuleSet && typeof obj.dynamicGroupRuleSet === "object") {
    obj = obj.dynamicGroupRuleSet as Record<string, unknown>; // unwrap the PUT envelope
  }
  return coerceScalars(stripCosmeticLabels(dropReadOnly(obj))) as Record<string, unknown>;
}

export interface NormalizedDynamic {
  status: DynamicStatus;
  ruleset: Record<string, unknown>;
}

export function normalizeDynamic(spec: { status: DynamicStatus; ruleset: unknown }): NormalizedDynamic {
  return { status: spec.status, ruleset: normalizeRuleset(spec.ruleset) };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/dynamic.test.ts`
Expected: PASS. If the live-fixture assertion reveals an unhandled shape (e.g. a nested envelope or a non-numeric id that must stay a string), adjust `normalizeRuleset` and re-run — the fixture is the arbiter.

- [ ] **Step 5: Commit**

```bash
git add src/engine/dynamic.ts tests/dynamic.test.ts
git commit -m "feat(dynamic): ruleset normalizer (labels, scalars, timestamps, envelope)"
```

---

## Task 5: `dynamic` synthetic-field entry (fold + apply)

**Files:**

- Modify: `src/engine/dynamic.ts` (add `resolveRulesetRef`)
- Modify: `src/engine/synthetic.ts` (register the `dynamic` field)
- Test: `tests/synthetic-dynamic.test.ts`

**Interfaces:**

- Consumes: `normalizeDynamic`, `normalizeRuleset` (Task 4); `SyntheticField` (Task 2); `CtClient.get/request`.
- Produces: a second entry in `SYNTHETIC_FIELDS` with `field: "dynamic"`.

**Design:** the desired side carries `dynamic` on the group's `DesiredResource`, not in `fields`. The `dynamic` fold injects a normalized `dynamic` value into **both** the group's desired `fields` and its `actual` record (fetched from `/dynamicgroups/{id}/ruleset` + `/status`), so the generic diff produces a single `dynamic` FieldChange. Apply routes that change to the ruleset/status endpoints.

- [ ] **Step 1: Write the failing test**

`tests/synthetic-dynamic.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SYNTHETIC_FIELDS, syntheticField } from "../src/engine/synthetic.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";

const dynamicField = () => syntheticField("dynamic")!;

describe("dynamic synthetic field — fold", () => {
  it("injects normalized dynamic into desired.fields and actual for an opted-in managed group", async () => {
    expect(SYNTHETIC_FIELDS.some((f) => f.field === "dynamic")).toBe(true);
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      {
        type: "group",
        key: "g",
        fields: { name: "G" },
        dependsOn: [],
        dynamic: { status: "manual", ruleset: { description: "x", query: {}, process: {} } },
      },
    ];
    const client = {
      get: vi.fn(async (p: string) =>
        p.endsWith("/ruleset")
          ? { description: "x", query: {}, process: {}, dynamicGroupUpdateStarted: "t" }
          : { dynamicGroupStatus: "manual" },
      ),
    };
    const out = await dynamicField().fold({ client, state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("g")?.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "x", query: {}, process: {} },
    });
    expect(out.desired[0]?.fields.dynamic).toEqual({
      status: "manual",
      ruleset: { description: "x", query: {}, process: {} },
    });
  });

  it("ignores groups that did not opt into dynamic", async () => {
    const state: State = {
      version: 1,
      host: "h",
      resources: {
        g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" },
      },
    };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [{ type: "group", key: "g", fields: { name: "G" }, dependsOn: [] }];
    const client = { get: vi.fn() };
    await dynamicField().fold({ client, state, desired, actual });
    expect(client.get).not.toHaveBeenCalled();
    expect(actual.get("g")).not.toHaveProperty("dynamic");
  });
});

describe("dynamic synthetic field — apply", () => {
  it("PUTs the wrapped ruleset then the status", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({
      client: { request },
      state,
      id: 5,
      change: {
        field: "dynamic",
        from: undefined,
        to: { status: "active", ruleset: { description: "x", query: {}, process: {} } },
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/dynamicgroups/5/ruleset", {
      dynamicGroupRuleSet: { description: "x", query: {}, process: {} },
    });
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "active",
    });
  });

  it("demotes to a normal group when status is none: DELETE ruleset then status none", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({
      client: { request },
      state,
      id: 5,
      change: {
        field: "dynamic",
        from: { status: "active", ruleset: {} },
        to: { status: "none", ruleset: {} },
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, "DELETE", "/dynamicgroups/5/ruleset");
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", {
      dynamicGroupStatus: "none",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/synthetic-dynamic.test.ts`
Expected: FAIL — no `dynamic` entry registered.

- [ ] **Step 3: Add `resolveRulesetRef` to `dynamic.ts`**

Append to `src/engine/dynamic.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

/** Resolve a `{ ref: "./file.json" }` ruleset to its JSON contents; pass through inline rulesets. */
export function resolveRulesetRef(ruleset: unknown, baseDir: string = process.cwd()): unknown {
  if (ruleset && typeof ruleset === "object" && typeof (ruleset as { ref?: unknown }).ref === "string") {
    const p = resolve(baseDir, (ruleset as { ref: string }).ref);
    return JSON.parse(readFileSync(p, "utf8"));
  }
  return ruleset;
}
```

(`dirname` import is for future per-config-file resolution; if unused now, omit it to satisfy `no-unused-vars`.)

- [ ] **Step 4: Register the `dynamic` field in `synthetic.ts`**

Add to `src/engine/synthetic.ts`:

```ts
import { normalizeDynamic, normalizeRuleset, resolveRulesetRef } from "./dynamic.js";
import type { DynamicStatus } from "./types.js";

const dynamicField: SyntheticField = {
  field: "dynamic",
  async fold({ client, state, desired, actual }) {
    const optedIn = new Set(
      desired.filter((d) => d.type === "group" && d.dynamic !== undefined).map((d) => d.key),
    );
    if (optedIn.size === 0) return { desired, errors: [] };
    const errors: string[] = [];
    for (const managed of Object.values(state.resources)) {
      if (managed.type !== "group" || !optedIn.has(managed.key)) continue;
      const a = actual.get(managed.key);
      if (!a) continue; // vanished from CT → handled as a recreate by the plain plan
      try {
        const ruleset = await client.get<Record<string, unknown>>(`/dynamicgroups/${managed.id}/ruleset`);
        const statusRes = await client.get<{ dynamicGroupStatus?: string }>(
          `/dynamicgroups/${managed.id}/status`,
        );
        a.dynamic = {
          status: (statusRes?.dynamicGroupStatus ?? "none") as DynamicStatus,
          ruleset: normalizeRuleset(ruleset),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`dynamic ${managed.key} (#${managed.id}): ${message}`);
      }
    }
    const augmented = desired.map((d) =>
      d.type === "group" && d.dynamic !== undefined
        ? {
            ...d,
            fields: {
              ...d.fields,
              dynamic: normalizeDynamic({
                status: d.dynamic.status,
                ruleset: resolveRulesetRef(d.dynamic.ruleset),
              }),
            },
          }
        : d,
    );
    return { desired: augmented, errors };
  },
  async apply({ client, id, change }) {
    const to = change.to as { status: DynamicStatus; ruleset: Record<string, unknown> } | undefined;
    if (!to || to.status === "none") {
      assertNotPeople(`/dynamicgroups/${id}/ruleset`);
      await client.request("DELETE", `/dynamicgroups/${id}/ruleset`);
      assertNotPeople(`/dynamicgroups/${id}/status`);
      await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: "none" });
      return;
    }
    assertNotPeople(`/dynamicgroups/${id}/ruleset`);
    await client.request("PUT", `/dynamicgroups/${id}/ruleset`, { dynamicGroupRuleSet: to.ruleset });
    assertNotPeople(`/dynamicgroups/${id}/status`);
    await client.request("PUT", `/dynamicgroups/${id}/status`, { dynamicGroupStatus: to.status });
  },
};

export const SYNTHETIC_FIELDS: SyntheticField[] = [parentsField, dynamicField];
```

(Replace the previous single-entry `SYNTHETIC_FIELDS` line.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run tests/synthetic-dynamic.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full suite (no regressions)**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engine/dynamic.ts src/engine/synthetic.ts tests/synthetic-dynamic.test.ts
git commit -m "feat(dynamic): synthetic-field fold + apply for ruleset & status"
```

---

## Task 6: End-to-end plan/apply + opt-in live round-trip test

**Files:**

- Modify: `src/commands/apply.ts` (add `--refresh` flag → per-group `POST /dynamicgroups/{id}/refresh` after a successful apply of a changed dynamic group)
- Test: `tests/dynamic.integration.test.ts` (opt-in, `CT_LIVE=1`)

**Interfaces:**

- Consumes: `buildPlan`, `executePlan`, the `dynamic` synthetic field.
- Produces: `ct apply --refresh` behavior; a green round-trip proof.

- [ ] **Step 1: Write the opt-in live round-trip test**

`tests/dynamic.integration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { authedSession } from "../src/api/session.js";

const live = process.env.CT_LIVE === "1";
const GID = Number(process.env.CT_DYNAMIC_FIXTURE_GID ?? "0"); // the group id from Task 1

describe.runIf(live)("dynamic round-trip (live)", () => {
  it("read → normalize → write-back is a no-op (drift-free)", async () => {
    const { client } = await authedSession();
    const before = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    const normalized = normalizeRuleset(before);
    await client.request("PUT", `/dynamicgroups/${GID}/ruleset`, { dynamicGroupRuleSet: normalized });
    const after = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    expect(normalizeRuleset(after)).toEqual(normalized); // writing back the normalized form does not drift
  });

  it("the committed fixture matches what the instance still returns", async () => {
    const { client } = await authedSession();
    const raw = JSON.parse(readFileSync("tests/fixtures/dynamic/ruleset.get.json", "utf8"));
    const fixture = raw.data ?? raw;
    const nowRuleset = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    expect(normalizeRuleset(nowRuleset)).toEqual(normalizeRuleset(fixture));
  });
});
```

- [ ] **Step 2: Run it (gated off by default → skipped)**

Run: `npx vitest run tests/dynamic.integration.test.ts`
Expected: SKIPPED (no `CT_LIVE`). Then run live: `CT_LIVE=1 CT_DYNAMIC_FIXTURE_GID=<gid> npx vitest run tests/dynamic.integration.test.ts` → PASS. If it fails, the normalizer is missing a real-world transform; fix `normalizeRuleset` and re-run.

- [ ] **Step 3: Add `--refresh` to `ct apply`**

In `src/commands/apply.ts`, add a `--refresh` option. After `executePlan` succeeds, for each applied item whose changes include a `dynamic` field, `POST /dynamicgroups/{id}/refresh` (per-group only). Guard: never call `/dynamicgroups/refresh` (all-groups). Show a one-line summary of `{created, updated, deleted}` from the response.

```ts
// after a successful executePlan(...)
if (opts.refresh) {
  for (const item of plan.items) {
    if (item.action === "no-op" || item.action === "delete") continue;
    if (!item.changes.some((c) => c.field === "dynamic")) continue;
    const id = state.resources[item.key]?.id;
    if (id === undefined) continue;
    const res = await client.request<Array<{ created: number; updated: number; deleted: number }>>(
      "POST",
      `/dynamicgroups/${id}/refresh`,
    );
    const r = res?.[0];
    if (r) info(`refreshed ${item.key}: +${r.created} ~${r.updated} -${r.deleted}`);
  }
}
```

(Use the file's existing logging helper in place of `info`.)

- [ ] **Step 4: Add a unit test for the refresh gating** (in `tests/apply.test.ts` or a new `tests/apply-refresh.test.ts`) asserting `POST /dynamicgroups/{id}/refresh` is called once per changed dynamic group and **never** `/dynamicgroups/refresh`, and not at all without `--refresh`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/commands/apply.ts tests/dynamic.integration.test.ts tests/apply-refresh.test.ts
git commit -m "feat(dynamic): end-to-end apply, opt-in --refresh, live round-trip test"
```

---

## Task 7: Typed query DSL (Phase 2)

**Files:**

- Create: `src/config/query.ts` (the `q.*` builder + resolver hook)
- Modify: `src/config/context.ts` (expose `q` and a `campus()`/`group()` key→id resolver on the context, or export `q` standalone)
- Test: `tests/query.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface QueryNode {
    [op: string]: unknown;
  }
  export const q: {
    and(...n: QueryNode[]): QueryNode;
    or(...n: QueryNode[]): QueryNode;
    not(n: QueryNode): QueryNode;
    eq(varName: string, value: unknown): QueryNode;
    oneof(varName: string, values: unknown[]): QueryNode;
    isnull(varName: string): QueryNode;
    var(name: string): QueryNode;
  };
  export function churchQuery(filter: QueryNode, opts?: { description?: string }): Record<string, unknown>;
  ```
- Consumes: `normalizeRuleset` (so a built query normalizes identically to a read-back one).

**Design:** `q.*` emits a JSONLogic tree; `churchQuery(filter)` wraps it in the ChurchQuery envelope `{ description, method: "ChurchQuery", params: { filter } }` that the ruleset expects. `var` values are raw ids — the config author resolves keys via the existing pattern (a campus/group id is looked up from live/state at config-build time; for Phase 2 keep resolution explicit — the author passes the numeric id or a resolver result — rather than hiding a live call inside `q`).

- [ ] **Step 1: Write the failing test**

`tests/query.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { q, churchQuery } from "../src/config/query.js";
import { normalizeRuleset } from "../src/engine/dynamic.js";

describe("typed query builder", () => {
  it("builds a JSONLogic tree", () => {
    const tree = q.and(q.eq("ctgroup.campusId", 1), q.eq("person.isArchived", false));
    expect(tree).toEqual({
      and: [{ "==": [{ var: "ctgroup.campusId" }, 1] }, { "==": [{ var: "person.isArchived" }, false] }],
    });
  });

  it("oneof and isnull", () => {
    expect(q.oneof("ctgroup.groupTypeId", [1, 2])).toEqual({
      oneof: [{ var: "ctgroup.groupTypeId" }, [1, 2]],
    });
    expect(q.isnull("person.isArchived")).toEqual({ isnull: [{ var: "person.isArchived" }] });
  });

  it("churchQuery wraps the filter in the ChurchQuery envelope", () => {
    const cq = churchQuery(q.eq("ctgroup.campusId", 1), { description: "Mainz" });
    expect(cq).toEqual({
      description: "Mainz",
      method: "ChurchQuery",
      params: { filter: { "==": [{ var: "ctgroup.campusId" }, 1] } },
    });
  });

  it("a built ruleset normalizes stably (matches read-back normalization)", () => {
    const ruleset = {
      description: "x",
      importance: 0,
      personIdFieldName: "id",
      process: {},
      query: churchQuery(q.eq("ctgroup.campusId", 1)),
    };
    expect(normalizeRuleset(normalizeRuleset(ruleset))).toEqual(normalizeRuleset(ruleset));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/query.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/config/query.ts`**

```ts
/**
 * Typed query builder for dynamic-group rulesets (Phase 2). Emits a JSONLogic
 * tree that lives inside the ChurchQuery `params.filter`. `var` values are raw
 * ChurchTools ids — resolve keys → ids at config-build time and pass the number.
 */
export interface QueryNode {
  [op: string]: unknown;
}

export const q = {
  and: (...n: QueryNode[]): QueryNode => ({ and: n }),
  or: (...n: QueryNode[]): QueryNode => ({ or: n }),
  not: (n: QueryNode): QueryNode => ({ "!": n }),
  var: (name: string): QueryNode => ({ var: name }),
  eq: (varName: string, value: unknown): QueryNode => ({ "==": [{ var: varName }, value] }),
  oneof: (varName: string, values: unknown[]): QueryNode => ({ oneof: [{ var: varName }, values] }),
  isnull: (varName: string): QueryNode => ({ isnull: [{ var: varName }] }),
};

/** Wrap a JSONLogic filter in the ChurchQuery envelope the ruleset `query` field expects. */
export function churchQuery(filter: QueryNode, opts: { description?: string } = {}): Record<string, unknown> {
  return { description: opts.description ?? "", method: "ChurchQuery", params: { filter } };
}
```

- [ ] **Step 4: Run to verify it passes; reconcile with the live fixture**

Run: `npx vitest run tests/query.test.ts`
Expected: PASS. Then compare `churchQuery(...)` output against the real `query` in `tests/fixtures/dynamic/ruleset.get.json`: if the live envelope carries extra required `params` keys (e.g. `responseFields`, `primaryEntityAlias`), add them as defaulted options to `churchQuery` and extend the test. The fixture is the arbiter of the envelope's required shape.

- [ ] **Step 5: Export `q`/`churchQuery` from the config surface**

Re-export from wherever the config DSL is imported (e.g. add to `src/config/context.ts` exports or a barrel the config file imports), so a `ct.config.ts` can `import { q, churchQuery } from "ct-cli/query"` (match the package's existing export convention — check `package.json` `exports`/`bin`; if none, document the import path in Task 8).

- [ ] **Step 6: Commit**

```bash
git add src/config/query.ts src/config/context.ts tests/query.test.ts
git commit -m "feat(dynamic): typed query builder + ChurchQuery envelope (Phase 2)"
```

---

## Task 8: Docs + example config

**Files:**

- Modify: `README.md` (add an "Auto-groups" subsection under usage/status)
- Create: `docs/dynamic-groups.md` (the full feature guide)
- Create: `examples/dynamic-group.config.ts` (a runnable example config)

- [ ] **Step 1: Write `docs/dynamic-groups.md`**

Cover: the `dynamic` block shape; `status` semantics (`active`/`manual`/`inactive`/`none`=demote); the three ways to supply a ruleset (inline object, `{ ref: "./rulesets/x.json" }`, typed `churchQuery(q.and(...))`); that membership is computed on refresh and `--refresh` is opt-in/per-group; the normalizer's guarantees (no cosmetic drift); and the managed-guard (an undeclared ruleset stays invisible).

- [ ] **Step 2: Write `examples/dynamic-group.config.ts`**

```ts
import { q, churchQuery } from "../src/config/query.js"; // or the published import path
export default (ct: any) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
  ct.group({
    key: "all_mainz",
    name: "Alle Mainz",
    groupTypeId: 1,
    dynamic: {
      status: "manual",
      ruleset: {
        description: "Alle aktiven Personen in Mainz", // description lives on the ruleset, NOT inside query
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(
          q.and(q.eq("ctgroup.campusId", 0 /* mainz id */), q.eq("person.isArchived", false)),
        ),
      },
    },
  });
};
```

- [ ] **Step 3: Add the README subsection**

Add a short "Auto-groups" block under the usage section pointing to `docs/dynamic-groups.md`, and flip the Phase 5 status bullet to note dynamic-groups landed.

- [ ] **Step 4: Verify the example loads**

Run: `CT_CONFIG=examples/dynamic-group.config.ts npx tsx src/index.ts plan --help 2>&1 | head` (or a dry `plan` against the live instance if logged in). Expected: no config-load/validation error from the example.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/dynamic-groups.md examples/dynamic-group.config.ts
git commit -m "docs(dynamic): auto-groups guide + runnable example config"
```

---

## Self-Review

**Spec coverage (against the #14 section of the design spec):**

- DSL `dynamic` block on a group → Task 3. ✓
- `ct plan` shows ruleset/status create/update/delete with a normalizer avoiding cosmetic false diffs → Tasks 4 (normalizer) + 5 (fold makes it a diffable field). ✓
- `ct apply` writes ruleset + status in the right order (group first); re-run is a no-op → Task 5 (apply order) + group tier 1 means the group item owns the write, exactly like `parents` (owner exists before the synthetic write). ✓
- `status: none` demotes; optional refresh materializes → Task 5 (none branch) + Task 6 (`--refresh`). ✓
- Round-trip test against a real dynamic group (read → normalize → write-back = no-op) → Task 6. ✓
- Typed query DSL (Phase 2) with name→ID resolution → Task 7 (builder + explicit id resolution; keys resolved at config-build time). ✓
- Opaque round-trip + `{ ref }` file reference → Task 3 (accepts any object) + Task 5 (`resolveRulesetRef`). ✓
- Managed-guard / per-group refresh / no refresh-all → Tasks 5 (opted-in only) + 6 (per-group gate). ✓

**Placeholder scan:** the only deferred specifics are the `dterm`/`params.filter` internals, which Task 1 captures live and Tasks 4/7 validate against the committed fixture — real code is provided for every known transform; no `TODO`/`TBD`/"handle edge cases". The `apply.ts` refresh snippet uses the file's existing logger (named `info` as a stand-in — the implementer substitutes the real helper, which exists).

**Type consistency:** `SyntheticField`/`SyntheticFoldCtx`/`SyntheticApplyCtx` (Task 2) are consumed unchanged in Task 5; `DynamicSpec`/`DynamicStatus` (Task 3) flow into `normalizeDynamic` (Task 4) and the `dynamic` fold/apply (Task 5); `normalizeRuleset` (Task 4) is reused by Tasks 6 and 7; `churchQuery`/`q` (Task 7) produce input that Task 4's normalizer accepts. No signature drift.
