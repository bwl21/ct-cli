# Blueprints Implementation Plan — Issue #7

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove and document that the config DSL supports parametrized, reusable campus blueprints — a blueprint function instantiated across ≥2 campuses produces a correct, dependency-ordered plan, and composes with auto-groups (#14) and permission grants (#13).

**Architecture:** No new engine machinery. The DSL (`(ct) => { ... }`, `src/config/context.ts`) is already a plain function receiving an injected context, so a blueprint is just a function `(campus: string) => { ct.group(...); ... }` called in a loop over campuses. This issue delivers a runnable example, a test that locks the ordered-plan guarantee, and docs. **YAGNI: add no abstraction** unless a helper obviously earns its place.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Vitest.

## Global Constraints

- Node ≥ 20; ESM NodeNext — all relative imports use `.js` specifiers.
- Add no new runtime dependency.
- People are never managed.
- Blueprints use ONLY the existing DSL surface (`ct.campus/group/groupType/.../groupRole/groupTypeRole`, `dynamic`, `parents`) — this issue must not require new DSL functions.
- The example is verified by config-LOAD only (no live `plan`/`apply`; the machine is on production).

## Context from #14 / #13 (already merged on this branch)

- `dynamic: { status, ruleset }` block on a group; `q`/`churchQuery` typed query builder re-exported from `src/config/context.js`.
- `ct.groupTypeRole({ key, id, grants })` with `module:right` grant names; `ct.groupRole({ key, id, grants })`.
- `parents: [groupKey]` opt-in hierarchy; `evaluateConfig(mod) → { resources, permissions }`; `orderKeys(resources)` (`src/engine/graph.ts`) topologically orders by tier then declaration order.

---

## Task 1: Example campus blueprint config

**Files:**

- Create: `examples/campus-blueprint.config.ts`

**Interfaces:**

- Produces: a default-exported `(ct) => void` config that defines a `kidsArea(campus)` blueprint and instantiates it across two campuses. Consumed by Task 2's test and by users as a reference.

- [ ] **Step 1: Write the blueprint example**

```ts
/**
 * Parametrized campus blueprint: define the Kids area once, instantiate per campus.
 * Demonstrates that the config DSL needs no special "blueprint" machinery — a
 * blueprint is a plain function over the injected context, called in a loop.
 */
import type { ConfigContext } from "../src/config/context.js";
import { q, churchQuery } from "../src/config/context.js";

const CAMPUSES = ["mainz", "berlin"] as const;

/** One campus's Kids area: a lead group with three ministry teams under it, plus a dynamic "all members" group. */
function kidsArea(ct: ConfigContext, campus: string): void {
  const lead = `${campus}_kids_lead`;
  ct.group({ key: lead, name: `${campus} · Kids Leitung`, groupTypeId: 2, parents: [] });
  for (const [suffix, label] of [
    ["0_3", "0–3"],
    ["4_6", "4–6"],
    ["checkin", "Check-in"],
  ] as const) {
    ct.group({
      key: `${campus}_kids_${suffix}`,
      name: `${campus} · Kids ${label}`,
      groupTypeId: 2,
      parents: [lead], // managed hierarchy: team sits under the campus lead group
    });
  }
  // A dynamic auto-group (#14) composed inside the blueprint.
  ct.group({
    key: `${campus}_kids_all`,
    name: `${campus} · Kids (alle)`,
    groupTypeId: 2,
    parents: [lead],
    dynamic: {
      status: "manual",
      ruleset: {
        description: `Alle aktiven Kids-Mitarbeiter ${campus}`,
        importance: 0,
        personIdFieldName: "person.id",
        process: {},
        query: churchQuery(q.eq("person.isArchived", false)),
      },
    },
  });
}

export default (ct: ConfigContext): void => {
  for (const campus of CAMPUSES) {
    ct.campus({ key: campus, name: `Campus ${campus}`, shorty: campus.slice(0, 3).toUpperCase() });
    kidsArea(ct, campus);
  }
  // A permission grant (#13) on a shared group-type-role template — id is an illustrative placeholder.
  ct.groupTypeRole({
    key: "kids_lead_tpl",
    id: 2,
    grants: ["churchgroup:view group", "churchgroup:edit group members"],
  });
};
```

- [ ] **Step 2: Verify it loads (config-load only — NO live plan/apply)**

Run:

```bash
npx tsx -e "import('./src/config/load.js').then(m=>m.loadConfig('examples/campus-blueprint.config.ts')).then(r=>console.log('resources',r.resources.length,'permissions',r.permissions.length)).catch(e=>{console.error(e.message);process.exit(1)})"
```

Expected: `resources 12 permissions 1` (2 campuses + 2×5 groups [lead + 3 teams + 1 dynamic] = 12 resources; 1 permission). No load/validation error. Do NOT run `ct plan`/`ct apply` (production login).

- [ ] **Step 3: Commit**

```bash
git add examples/campus-blueprint.config.ts
git commit -m "feat(blueprints): example parametrized campus blueprint (kids area × 2 campuses)"
```

---

## Task 2: Ordered-plan test (the DoD lock)

**Files:**

- Create: `tests/blueprint.test.ts`

**Interfaces:**

- Consumes: `evaluateConfig` (`src/config/context.js`), `orderKeys` (`src/engine/graph.js`), and the Task 1 blueprint pattern (the test defines its own inline blueprint so it does not depend on the example file's exact ids).

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { evaluateConfig, type ConfigContext } from "../src/config/context.js";
import { orderKeys } from "../src/engine/graph.js";

// A blueprint instantiated across two campuses — the core #7 guarantee.
const blueprint = (ct: ConfigContext): void => {
  for (const c of ["mainz", "berlin"]) {
    ct.campus({ key: c, name: `Campus ${c}`, shorty: c.slice(0, 3) });
    ct.group({ key: `${c}_lead`, name: `${c} lead`, groupTypeId: 2, parents: [] });
    ct.group({ key: `${c}_team`, name: `${c} team`, groupTypeId: 2, parents: [`${c}_lead`] });
  }
};

describe("campus blueprint", () => {
  it("instantiates the full structure for every campus", async () => {
    const { resources } = await evaluateConfig(blueprint);
    const keys = resources.map((r) => r.key).sort();
    expect(keys).toEqual(["berlin", "berlin_lead", "berlin_team", "mainz", "mainz_lead", "mainz_team"]);
  });

  it("produces a correctly ordered plan: campuses before groups, parents before children", async () => {
    const { resources } = await evaluateConfig(blueprint);
    const order = orderKeys(resources);
    const pos = (k: string) => order.indexOf(k);
    for (const c of ["mainz", "berlin"]) {
      expect(pos(c)).toBeLessThan(pos(`${c}_lead`)); // campus (tier 0) before its groups (tier 1)
      expect(pos(`${c}_lead`)).toBeLessThan(pos(`${c}_team`)); // parent before child (intra-tier dependency)
    }
  });

  it("rejects a blueprint whose managed parent is undeclared (typo guard)", async () => {
    const broken = (ct: ConfigContext) => {
      ct.group({ key: "g", name: "g", groupTypeId: 2, parents: ["missing"] });
    };
    await expect(evaluateConfig(broken)).rejects.toThrow(/not declared/i);
  });
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run tests/blueprint.test.ts && npm run typecheck && npm run lint`
Expected: PASS (these exercise existing, merged behavior; the test documents/locks the blueprint guarantee).

- [ ] **Step 3: Commit**

```bash
git add tests/blueprint.test.ts
git commit -m "test(blueprints): lock ordered-plan guarantee for a blueprint across 2 campuses"
```

---

## Task 3: Docs + README

**Files:**

- Create: `docs/blueprints.md`
- Modify: `README.md`

- [ ] **Step 1: Write `docs/blueprints.md`**

Cover: a blueprint is a plain function over the injected `ConfigContext` (no special machinery); the loop-over-campuses pattern; how `parents` scopes hierarchy per campus with `${campus}_`-prefixed keys; composing an auto-group (`dynamic`) and a permission grant (`groupTypeRole`) inside a blueprint; that the dependency graph orders campuses → groups → hierarchy automatically; and the managed-parent typo guard. Link to `examples/campus-blueprint.config.ts`.

- [ ] **Step 2: Update `README.md`**

Add a short "Blueprints" subsection under usage pointing to `docs/blueprints.md`, and flip the Phase 5 status bullet to note blueprints + permissions + auto-groups all landed (Phase 5 complete).

- [ ] **Step 3: Commit**

```bash
git add docs/blueprints.md README.md
git commit -m "docs(blueprints): parametrized campus blueprint guide; Phase 5 complete"
```

---

## Self-Review

**Spec coverage (#7 design + DoD):**

- Blueprint abstraction (TS function parametrized by campus) → Task 1 (`kidsArea`), Task 2 (inline blueprint). ✓
- Reusable building blocks shared across blueprints → the `kidsArea` function + shared group type/status ids; no new abstraction needed (YAGNI). ✓
- Auto-groups inside a blueprint → Task 1 (`dynamic` block in `kidsArea`). ✓ (dynamic reconciliation idempotency is covered by #14's tests + normalizer.)
- One blueprint across ≥2 campuses → correct ordered plan → Task 2 (ordering assertions). ✓
- Apply builds the full structure for a new campus → the ordered plan + #14/#13 apply mechanisms already cover this; not live-tested here (production login) — noted in docs. ✓ (⚠️ controller: a live apply-a-new-campus check would need a dev instance.)

**Placeholder scan:** none — all steps carry real code/commands. The example's `groupTypeId`/`id` values are illustrative (documented as such, mirroring the #14/#13 examples).

**Type consistency:** `ConfigContext`, `evaluateConfig`, `q`/`churchQuery` (from `src/config/context.js`) and `orderKeys` (from `src/engine/graph.js`) are all existing, merged exports used with their current signatures.
