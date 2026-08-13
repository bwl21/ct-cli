# Permissions as Code Implementation Plan — Issue #13

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manage ChurchTools permission grants on `group_role` and `group_type_role` domain objects as declarative code — human-readable `module:right` names, idempotent set reconciliation via PUT/DELETE.

**Architecture:** Permissions are a **standalone reconciliation subsystem** (`src/permissions/`), not folded into the group-body engine: a grant is a tuple `(domainType, domainId, authId, dataId[])` reconciled as a set (no create/update split, no POST). A grant-bearing declaration (`ct.groupRole`/`ct.groupTypeRole`) names an existing domain object by explicit `id` and a `grants` set. The subsystem resolves names→authId via a shipped static catalog, fetches actual grants per domainType (excluding the self-re-adding system baseline), diffs as sets, and writes PUT (grant/revoke) / DELETE per tuple. It reuses the state file, `assertNotPeople`, and the plan/apply commands.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` specifiers), Vitest, existing `CtClient`.

## Global Constraints

- Node ≥ 20; ESM NodeNext — **all relative imports use `.js` specifiers**.
- Add no new runtime dependency.
- People are never managed: every write path passes through `assertNotPeople` (`src/engine/guard.ts`).
- Managed-guard: only the domain objects explicitly declared (or in state) are reconciled; every other permission assignment in ChurchTools is invisible.
- CT ids can be `0` — never truthiness on an id.
- Tests mirror `tests/*.test.ts` (Vitest, import from `../src/**/*.js`).
- Live instance is currently **production** (`eqrm.church.tools`) — investigation is read-only; any write/round-trip test is gated behind `CT_LIVE=1` and must target a **dev** instance, never run against production.

## Authoritative findings (live, 2026-07-08)

- **Catalog** (`src/permissions/catalog.json`, already committed): 187 rights, `"module:right" → { authId, scopeField, revocable, desc }`. `scopeField` non-null ⇒ the right takes a `dataId[]` scope (71 such rights, e.g. `churchgroup:view group` → `authId 1104`, `scopeField "cdb_gruppe"`). Not available via REST — captured from the `POST /index.php?q=churchauth/ajax  func=getMasterData` `auth_table`.
- **Raw assignment / GET** `GET /permissions/{domainType}` (and `/{domainType}/{domainId}`) → `{ data: Permission[] }`, `Permission = { domainType, domainId, authId, dataId: int|null, isInherited, type: "grant"|"revoke", reason, meta: { modifiedDate, modifiedPid } }`. **`dataId` is a scalar `int|null` on read.**
- **Write** `PUT /permissions/{domainType}/{domainId}` body = single `PermissionRequest { authId, dataId?: int[], isInherited?: bool, type?: "grant"|"revoke", reason?: string }` — **`dataId` is an array on write.** `DELETE` same path, same body shape (tuple in body). Both return no content.
- **Domain rules** (from the `PermissionRequest` schema + live data): `authId < 10000` required for `status`/`person`/`group_type_role` writes (authId `10127` unsupported); `type:"revoke"` only for `group_role`; `isInherited:true` only for `group_role`/`group_type_role`.
- **Baseline:** rows with `meta.modifiedPid === -1` (system-authored) and `isInherited === true` re-add themselves — exclude them from the diff set so reconciliation doesn't fight the system.
- **domainId:** `group_role` domainId is an internal (group,role)-link id (range 51–43623, no clean enumeration endpoint) → the DSL takes it **explicitly**. `group_type_role` domainId is a template id (small).

**Note on `CtClient.request`:** unwraps `{ data }` automatically, so `client.get("/permissions/group_role")` returns `Permission[]` directly.

---

## Task 1: Catalog resolver

**Files:**

- Create: `src/permissions/catalog.ts`
- Test: `tests/permission-catalog.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface CatalogEntry {
    authId: number;
    scopeField: string | null;
    revocable: boolean;
    desc: string;
  }
  export function loadCatalog(): Record<string, CatalogEntry>; // reads catalog.json once (memoized)
  export function resolveAuthId(name: string): CatalogEntry; // throws with suggestions if unknown
  ```
- Consumes: the committed `src/permissions/catalog.json`.

- [ ] **Step 1: Write the failing test**

`tests/permission-catalog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveAuthId, loadCatalog } from "../src/permissions/catalog.js";

describe("permission catalog", () => {
  it("resolves a known global right to its authId", () => {
    const e = resolveAuthId("churchgroup:view");
    expect(e.authId).toBe(1101);
    expect(e.scopeField).toBeNull();
  });
  it("resolves a scoped right and exposes its scopeField", () => {
    const e = resolveAuthId("churchgroup:view group");
    expect(e.authId).toBe(1104);
    expect(e.scopeField).toBe("cdb_gruppe");
  });
  it("throws a helpful error for an unknown right", () => {
    expect(() => resolveAuthId("churchgroup:no such right")).toThrow(
      /unknown permission "churchgroup:no such right"/i,
    );
  });
  it("loads the whole catalog (187 rights)", () => {
    expect(Object.keys(loadCatalog()).length).toBeGreaterThanOrEqual(180);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/permission-catalog.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/permissions/catalog.ts`**

```ts
/**
 * The permission catalog: the static name→authId bridge (see src/permissions/README.md).
 * The catalog is reference data captured from the instance's churchauth masterdata; it is
 * NOT available via the REST API, so it is shipped as JSON and read from disk once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export interface CatalogEntry {
  authId: number;
  scopeField: string | null;
  revocable: boolean;
  desc: string;
}

let cache: Record<string, CatalogEntry> | null = null;

export function loadCatalog(): Record<string, CatalogEntry> {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  cache = JSON.parse(readFileSync(join(here, "catalog.json"), "utf8")) as Record<string, CatalogEntry>;
  return cache;
}

export function resolveAuthId(name: string): CatalogEntry {
  const entry = loadCatalog()[name];
  if (!entry) {
    const [mod] = name.split(":");
    const near = Object.keys(loadCatalog())
      .filter((k) => k.startsWith(`${mod}:`))
      .slice(0, 6);
    const hint = near.length ? ` Did you mean one of: ${near.join(", ")}?` : "";
    throw new Error(`Unknown permission "${name}".${hint}`);
  }
  return entry;
}
```

(`catalog.ts` compiles to `dist/permissions/`; ensure the build copies `catalog.json` next to it — see Task 8's build note. During `tsx`/vitest it reads from `src/permissions/`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/permission-catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/catalog.ts tests/permission-catalog.test.ts
git commit -m "feat(permissions): catalog resolver (name→authId, scope, revocable)"
```

---

## Task 2: Grant-tuple model + set reconciliation

**Files:**

- Create: `src/permissions/grants.ts`
- Test: `tests/permission-grants.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export type DomainType = "group_role" | "group_type_role";
  export interface GrantTuple {
    authId: number;
    dataId: number[];
    type: "grant" | "revoke";
  } // dataId sorted; [] = unscoped
  export interface RawPermission {
    authId: number;
    dataId: number | null;
    type: "grant" | "revoke";
    isInherited?: boolean;
    meta?: { modifiedPid?: number };
  }
  export function tupleKey(t: { authId: number; dataId: number[]; type: string }): string; // stable identity
  export function normalizeActual(rows: RawPermission[]): GrantTuple[]; // exclude baseline+inherited; scalar dataId→[]
  export interface GrantDiff {
    toPut: GrantTuple[];
    toDelete: GrantTuple[];
  }
  export function diffGrants(desired: GrantTuple[], actual: GrantTuple[]): GrantDiff; // set reconciliation
  ```
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the failing test**

`tests/permission-grants.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeActual, diffGrants, tupleKey } from "../src/permissions/grants.js";

describe("normalizeActual", () => {
  it("coerces scalar dataId to a sorted array and drops baseline + inherited rows", () => {
    const rows = [
      { authId: 1104, dataId: 3, type: "grant" as const, meta: { modifiedPid: 1 } },
      { authId: 1101, dataId: null, type: "grant" as const, meta: { modifiedPid: 1 } },
      { authId: 9999, dataId: 1, type: "grant" as const, meta: { modifiedPid: -1 } }, // system baseline → excluded
      { authId: 8888, dataId: 1, type: "grant" as const, isInherited: true }, // inherited → excluded
    ];
    expect(normalizeActual(rows)).toEqual([
      { authId: 1104, dataId: [3], type: "grant" },
      { authId: 1101, dataId: [], type: "grant" },
    ]);
  });
});

describe("diffGrants", () => {
  it("adds missing, deletes extra, no-ops identical (order-independent dataId)", () => {
    const desired = [
      { authId: 1104, dataId: [7, 3], type: "grant" as const }, // present but reordered
      { authId: 1101, dataId: [], type: "grant" as const }, // new
    ];
    const actual = [
      { authId: 1104, dataId: [3, 7], type: "grant" as const }, // same tuple, different order
      { authId: 2000, dataId: [], type: "grant" as const }, // extra → delete
    ];
    const d = diffGrants(desired, actual);
    expect(d.toPut.map(tupleKey)).toEqual([tupleKey({ authId: 1101, dataId: [], type: "grant" })]);
    expect(d.toDelete.map(tupleKey)).toEqual([tupleKey({ authId: 2000, dataId: [], type: "grant" })]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/permission-grants.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/permissions/grants.ts`**

```ts
/**
 * Grant tuples and set reconciliation. A grant's identity is (authId, sorted dataId, type).
 * Actuals exclude the self-re-adding system baseline (modifiedPid === -1) and inherited rows,
 * so reconciliation owns only user-authored grants and never fights the platform.
 */
export type DomainType = "group_role" | "group_type_role";

export interface GrantTuple {
  authId: number;
  dataId: number[];
  type: "grant" | "revoke";
}
export interface RawPermission {
  authId: number;
  dataId: number | null;
  type: "grant" | "revoke";
  isInherited?: boolean;
  meta?: { modifiedPid?: number };
}

export function tupleKey(t: { authId: number; dataId: number[]; type: string }): string {
  return `${t.type}:${t.authId}:${[...t.dataId].sort((a, b) => a - b).join(",")}`;
}

export function normalizeActual(rows: RawPermission[]): GrantTuple[] {
  const out: GrantTuple[] = [];
  for (const r of rows) {
    if (r.meta?.modifiedPid === -1) continue; // system baseline — invisible to reconciliation
    if (r.isInherited) continue; // inherited — not directly owned here
    const dataId = r.dataId == null ? [] : [r.dataId];
    out.push({ authId: r.authId, dataId: dataId.sort((a, b) => a - b), type: r.type });
  }
  return out;
}

export interface GrantDiff {
  toPut: GrantTuple[];
  toDelete: GrantTuple[];
}

export function diffGrants(desired: GrantTuple[], actual: GrantTuple[]): GrantDiff {
  const desiredKeys = new Map(desired.map((t) => [tupleKey(t), t]));
  const actualKeys = new Map(actual.map((t) => [tupleKey(t), t]));
  const toPut = [...desiredKeys].filter(([k]) => !actualKeys.has(k)).map(([, t]) => t);
  const toDelete = [...actualKeys].filter(([k]) => !desiredKeys.has(k)).map(([, t]) => t);
  return { toPut, toDelete };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/permission-grants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/grants.ts tests/permission-grants.test.ts
git commit -m "feat(permissions): grant-tuple model + set reconciliation (baseline-tolerant)"
```

---

## Task 3: DSL — `ct.groupRole` / `ct.groupTypeRole`

**Files:**

- Modify: `src/config/context.ts` (add the two declarations)
- Create: `src/permissions/types.ts` (the desired-permission shape)
- Test: `tests/context.test.ts` (extend)

**Interfaces:**

- Produces:
  ```ts
  // src/permissions/types.ts
  export type Grant = string | { right: string; scope: string[] };
  export interface DesiredPermission {
    key: string;
    domainType: DomainType;
    domainId: number;
    grants: Grant[];
  }
  // ConfigContext gains: groupRole(input), groupTypeRole(input)
  // evaluateConfig now returns BOTH resource declarations and permission declarations.
  ```
- Consumes: `DomainType` (Task 2).

**Design:** permission declarations live in a **separate list** from `DesiredResource[]` (they reconcile through their own subsystem, not the group engine). `evaluateConfig` returns `{ resources, permissions }`; update `loadConfig` and its callers to thread `permissions` (default `[]` when a config declares none — backward compatible).

- [ ] **Step 1: Write the failing test** (append to `tests/context.test.ts`)

```ts
describe("permission declarations", () => {
  it("collects groupRole / groupTypeRole with validated grants", async () => {
    const mod = (ct: any) => {
      ct.groupTypeRole({
        key: "leiter_tpl",
        id: 8,
        grants: ["churchgroup:view group", { right: "churchdb:view group", scope: ["kids_area"] }],
      });
      ct.groupRole({ key: "kids_lead", id: 2882, grants: ["churchgroup:edit group members"] });
    };
    const { permissions } = await evaluateConfig(mod); // evaluateConfig now returns {resources, permissions}
    expect(permissions).toHaveLength(2);
    expect(permissions[0]).toMatchObject({ key: "leiter_tpl", domainType: "group_type_role", domainId: 8 });
    expect(permissions[1]).toMatchObject({ key: "kids_lead", domainType: "group_role", domainId: 2882 });
  });
  it("rejects a non-numeric id and an empty right name", async () => {
    await expect(
      evaluateConfig((ct: any) => ct.groupRole({ key: "x", id: "nope", grants: [] })),
    ).rejects.toThrow(/id.*number/i);
    await expect(
      evaluateConfig((ct: any) => ct.groupRole({ key: "x", id: 1, grants: [""] })),
    ).rejects.toThrow(/grant/i);
  });
});
```

(Adjust the existing `evaluateConfig` import/usages in this file to the new `{ resources, permissions }` return.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/context.test.ts`
Expected: FAIL — `groupRole`/`groupTypeRole` not defined; `evaluateConfig` returns an array, not `{resources, permissions}`.

- [ ] **Step 3: Implement**

Create `src/permissions/types.ts` with the interfaces above.

In `src/config/context.ts`:

- Add a `permissions: DesiredPermission[]` accumulator alongside `resources` in `createContext`.
- Add `groupRole` and `groupTypeRole` to `ConfigContext` and the returned `ct`:

```ts
  const definePermission = (domainType: DomainType) => (input: { key: string; id: number; grants: Grant[] }): void => {
    if (typeof input.key !== "string" || !input.key) throw new Error(`${domainType} declaration missing a string "key".`);
    if (typeof input.id !== "number") throw new Error(`${domainType} "${input.key}": "id" must be a number (the domainId).`);
    if (!Array.isArray(input.grants)) throw new Error(`${domainType} "${input.key}": "grants" must be an array.`);
    for (const g of input.grants) {
      const right = typeof g === "string" ? g : g?.right;
      if (typeof right !== "string" || !right.includes(":")) throw new Error(`${domainType} "${input.key}": each grant must be a "module:right" string or { right, scope }.`);
      if (typeof g === "object" && !Array.isArray(g.scope)) throw new Error(`${domainType} "${input.key}": scoped grant needs "scope": string[].`);
    }
    if (seen.has(input.key)) throw new Error(`Duplicate logical key "${input.key}" in config.`);
    seen.add(input.key);
    permissions.push({ key: input.key, domainType, domainId: input.id, grants: input.grants });
  };
  // ...
  groupRole: definePermission("group_role"),
  groupTypeRole: definePermission("group_type_role"),
```

(Share the existing `seen` set so keys stay globally unique across resources and permissions.)

- Change `createContext` to return `{ ct, resources, permissions }` and `evaluateConfig` to return `{ resources, permissions }`. Update `validateReferences` call site accordingly.

In `src/config/load.ts`: `loadConfig` returns `{ resources, permissions }`. Update `src/commands/plan.ts` and `src/commands/apply.ts` to destructure (they currently do `const desired = await loadConfig(...)`) — thread `permissions` through (used in Task 5/6). Keep existing resource behavior identical.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/context.test.ts tests/load.test.ts && npm run typecheck`
Expected: PASS (fix any load.test.ts expectations for the new return shape).

- [ ] **Step 5: Commit**

```bash
git add src/config/context.ts src/config/load.ts src/permissions/types.ts src/commands/plan.ts src/commands/apply.ts tests/
git commit -m "feat(permissions): groupRole/groupTypeRole DSL + threaded permission declarations"
```

---

## Task 4: Scope resolver (scope keys → dataId[])

**Files:**

- Create: `src/permissions/scope.ts`
- Test: `tests/permission-scope.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export function resolveScope(scopeKeys: string[], state: State): number[]; // logical group keys → group ids, sorted
  ```
- Consumes: `State` (`src/state/state.js`).

**Design (MVP):** scoped rights whose `scopeField` is `cdb_gruppe` take group `dataId`s. Resolve each scope key as a managed **group** logical key → its CT id (from state). Unknown key → clear error. (Other scope fields — `cdb_bereich`, `cdb_station` — are out of MVP scope; a scope key that doesn't resolve to a managed group errors with guidance. Extend later.)

- [ ] **Step 1: Write the failing test**

`tests/permission-scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveScope } from "../src/permissions/scope.js";
import type { State } from "../src/state/state.js";

const state: State = {
  version: 1,
  host: "h",
  resources: {
    kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
    other: { type: "group", id: 7, key: "other", fields: {}, adoptedAt: "t", updatedAt: "t" },
  },
};

describe("resolveScope", () => {
  it("maps managed group keys to sorted ids", () => {
    expect(resolveScope(["other", "kids_area"], state)).toEqual([7, 42]);
  });
  it("throws for a key that is not a managed group", () => {
    expect(() => resolveScope(["nope"], state)).toThrow(/scope key "nope"/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/permission-scope.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/permissions/scope.ts`**

```ts
import type { State } from "../state/state.js";

/** Resolve scope logical keys to sorted group dataIds. MVP: scope keys must be managed groups. */
export function resolveScope(scopeKeys: string[], state: State): number[] {
  const ids: number[] = [];
  for (const key of scopeKeys) {
    const m = state.resources[key];
    if (!m || m.type !== "group") {
      throw new Error(
        `Scope key "${key}" does not resolve to a managed group. Declare/adopt it, or use a group already under management.`,
      );
    }
    ids.push(m.id);
  }
  return ids.sort((a, b) => a - b);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/permission-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/scope.ts tests/permission-scope.test.ts
git commit -m "feat(permissions): scope-key → group dataId resolver"
```

---

## Task 5: Build the permission plan (desired tuples + actuals + diff + validation)

**Files:**

- Create: `src/permissions/plan.ts`
- Test: `tests/permission-plan.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export interface PermissionPlanItem {
    key: string;
    domainType: DomainType;
    domainId: number;
    diff: GrantDiff;
  }
  export function desiredTuples(p: DesiredPermission, state: State): GrantTuple[]; // resolve names+scope, validate domain rules
  export async function buildPermissionPlan(
    client: Pick<CtClient, "get">,
    state: State,
    permissions: DesiredPermission[],
  ): Promise<{ items: PermissionPlanItem[]; fetchErrors: string[] }>;
  ```
- Consumes: `resolveAuthId` (T1), `normalizeActual`/`diffGrants`/`GrantTuple` (T2), `resolveScope` (T4), `DesiredPermission`/`DomainType` (T3).

**Domain-rule validation in `desiredTuples`** (throw a clear error):

- A scoped grant (`{right, scope}`) requires the catalog entry's `scopeField` to be non-null; a bare-string grant on a right whose `scopeField` is non-null is allowed (means "unscoped/all") — permitted.
- `type: "revoke"` is only produced for `group_role` (MVP only emits `grant`; revoke support is a later extension — do NOT emit revoke here, but keep the tuple `type` field).
- `group_type_role` + `authId >= 10000` → throw (write rule: those domains require authId < 10000).

**Managed-guard / fetch:** fetch actuals once per distinct `domainType` via bulk `GET /permissions/{domainType}`, then filter to the declared `domainId`s. A fetch failure records a `fetchError` (mirrors `build.ts`).

- [ ] **Step 1: Write the failing test**

`tests/permission-plan.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { desiredTuples, buildPermissionPlan } from "../src/permissions/plan.js";
import type { State } from "../src/state/state.js";

const state: State = {
  version: 1,
  host: "h",
  resources: {
    kids_area: { type: "group", id: 42, key: "kids_area", fields: {}, adoptedAt: "t", updatedAt: "t" },
  },
};

describe("desiredTuples", () => {
  it("resolves names and scope to tuples", () => {
    const tuples = desiredTuples(
      {
        key: "t",
        domainType: "group_type_role",
        domainId: 8,
        grants: [
          "churchgroup:view group", // authId 1104, unscoped
          { right: "churchgroup:view group", scope: ["kids_area"] }, // authId 1104, dataId [42]
        ],
      },
      state,
    );
    expect(tuples).toEqual([
      { authId: 1104, dataId: [], type: "grant" },
      { authId: 1104, dataId: [42], type: "grant" },
    ]);
  });
  it("rejects authId >= 10000 on group_type_role", () => {
    expect(() =>
      desiredTuples(
        { key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchdb:+see persons"] },
        state,
      ),
    ).toThrow(/10000/); // churchdb:+see persons is authId 10101
  });
});

describe("buildPermissionPlan", () => {
  it("diffs desired vs actual (bulk fetch filtered to managed domainIds)", async () => {
    const client = {
      get: vi.fn(async () => [
        {
          domainType: "group_type_role",
          domainId: 8,
          authId: 1104,
          dataId: null,
          type: "grant",
          meta: { modifiedPid: 1 },
        },
        {
          domainType: "group_type_role",
          domainId: 99,
          authId: 1,
          dataId: null,
          type: "grant",
          meta: { modifiedPid: 1 },
        }, // unmanaged domainId → ignored
      ]),
    };
    const { items, fetchErrors } = await buildPermissionPlan(client as never, state, [
      { key: "t", domainType: "group_type_role", domainId: 8, grants: ["churchgroup:view group"] },
    ]);
    expect(fetchErrors).toEqual([]);
    expect(items[0].diff.toPut).toEqual([]); // 1104 unscoped already present
    expect(items[0].diff.toDelete).toEqual([]); // domainId 99 is unmanaged → invisible
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/permission-plan.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/permissions/plan.ts`**

```ts
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import { resolveAuthId } from "./catalog.js";
import { resolveScope } from "./scope.js";
import {
  normalizeActual,
  diffGrants,
  type GrantTuple,
  type GrantDiff,
  type DomainType,
  type RawPermission,
} from "./grants.js";
import type { DesiredPermission } from "./types.js";

export interface PermissionPlanItem {
  key: string;
  domainType: DomainType;
  domainId: number;
  diff: GrantDiff;
}

export function desiredTuples(p: DesiredPermission, state: State): GrantTuple[] {
  return p.grants.map((g) => {
    const name = typeof g === "string" ? g : g.right;
    const entry = resolveAuthId(name);
    if (p.domainType === "group_type_role" && entry.authId >= 10000) {
      throw new Error(
        `${p.domainType} "${p.key}": "${name}" (authId ${entry.authId}) is not writable — ${p.domainType} requires authId < 10000.`,
      );
    }
    const dataId = typeof g === "string" ? [] : resolveScope(g.scope, state);
    return { authId: entry.authId, dataId, type: "grant" as const };
  });
}

export async function buildPermissionPlan(
  client: Pick<CtClient, "get">,
  state: State,
  permissions: DesiredPermission[],
): Promise<{ items: PermissionPlanItem[]; fetchErrors: string[] }> {
  const items: PermissionPlanItem[] = [];
  const fetchErrors: string[] = [];
  // one bulk fetch per distinct domainType
  const byType = new Map<DomainType, RawPermission[] | null>();
  for (const dt of new Set(permissions.map((p) => p.domainType))) {
    try {
      byType.set(dt, await client.get<RawPermission[]>(`/permissions/${dt}`));
    } catch (err) {
      const message = err instanceof CtApiError ? `${err.status}` : (err as Error).message;
      fetchErrors.push(`permissions ${dt}: ${message}`);
      byType.set(dt, null);
    }
  }
  for (const p of permissions) {
    const all = byType.get(p.domainType);
    if (all == null) continue; // fetch failed for this domainType — recorded above
    const actual = normalizeActual(all.filter((r) => (r as { domainId?: number }).domainId === p.domainId));
    items.push({
      key: p.key,
      domainType: p.domainType,
      domainId: p.domainId,
      diff: diffGrants(desiredTuples(p, state), actual),
    });
  }
  return { items, fetchErrors };
}
```

(Add `domainId` to `RawPermission` in `grants.ts` — `domainId: number` — so the filter typechecks.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/permission-plan.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/permissions/plan.ts src/permissions/grants.ts tests/permission-plan.test.ts
git commit -m "feat(permissions): build permission plan (tuples, bulk actuals, managed-guard, validation)"
```

---

## Task 6: Apply permissions + render + wire into commands + catalog helper

**Files:**

- Create: `src/permissions/apply.ts`, `src/permissions/render.ts`
- Modify: `src/commands/plan.ts`, `src/commands/apply.ts` (render + execute the permission plan)
- Modify: `src/commands/get.ts` (add `permissions-catalog`)
- Test: `tests/permission-apply.test.ts`

**Interfaces:**

- Produces:
  ```ts
  export async function applyPermissionPlan(
    items: PermissionPlanItem[],
    client: Pick<CtClient, "request">,
  ): Promise<{ granted: number; deleted: number }>;
  export function renderPermissionPlan(items: PermissionPlanItem[]): string;
  ```
- Consumes: `PermissionPlanItem` (T5), `assertNotPeople`.

**Apply:** per item, `PUT /permissions/{domainType}/{domainId}` with `{ authId, dataId, type }` for each `toPut` (omit `dataId` when empty → unscoped), `DELETE` same path with `{ authId, dataId }` for each `toDelete`. Guard every path with `assertNotPeople`. Idempotent (re-run diffs to empty).

**Command wiring:** in `plan.ts`/`apply.ts`, after the resource plan, `buildPermissionPlan(client, state, permissions)`; render its section; on apply (after resource `executePlan` succeeds) call `applyPermissionPlan`. Fold permission `fetchErrors` into the same incomplete-plan handling.

- [ ] **Step 1: Write the failing test**

`tests/permission-apply.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { applyPermissionPlan } from "../src/permissions/apply.js";

describe("applyPermissionPlan", () => {
  it("PUTs each grant and DELETEs each removed tuple with the array dataId body", async () => {
    const request = vi.fn(async () => ({}));
    const res = await applyPermissionPlan(
      [
        {
          key: "t",
          domainType: "group_type_role",
          domainId: 8,
          diff: {
            toPut: [
              { authId: 1104, dataId: [42], type: "grant" },
              { authId: 1101, dataId: [], type: "grant" },
            ],
            toDelete: [{ authId: 2000, dataId: [], type: "grant" }],
          },
        },
      ],
      { request } as never,
    );
    expect(res).toEqual({ granted: 2, deleted: 1 });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", {
      authId: 1104,
      dataId: [42],
      type: "grant",
    });
    expect(request).toHaveBeenCalledWith("PUT", "/permissions/group_type_role/8", {
      authId: 1101,
      type: "grant",
    }); // no dataId when unscoped
    expect(request).toHaveBeenCalledWith("DELETE", "/permissions/group_type_role/8", {
      authId: 2000,
      type: "grant",
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/permission-apply.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/permissions/apply.ts` and `render.ts`**

```ts
// src/permissions/apply.ts
import type { CtClient } from "../api/ctClient.js";
import { assertNotPeople } from "../engine/guard.js";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";

function body(t: GrantTuple): Record<string, unknown> {
  const b: Record<string, unknown> = { authId: t.authId, type: t.type };
  if (t.dataId.length) b.dataId = t.dataId; // omit when unscoped
  return b;
}

export async function applyPermissionPlan(
  items: PermissionPlanItem[],
  client: Pick<CtClient, "request">,
): Promise<{ granted: number; deleted: number }> {
  let granted = 0,
    deleted = 0;
  for (const item of items) {
    const path = `/permissions/${item.domainType}/${item.domainId}`;
    assertNotPeople(path);
    for (const t of item.diff.toPut) {
      await client.request("PUT", path, body(t));
      granted++;
    }
    for (const t of item.diff.toDelete) {
      await client.request("DELETE", path, body(t));
      deleted++;
    }
  }
  return { granted, deleted };
}
```

`render.ts`: format each item as `group_type_role #8: +2 grant(s), -1 revoke(s)` with per-tuple lines (reuse `picocolors` like `engine/render.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/permission-apply.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into commands + `ct get permissions-catalog`**

- `plan.ts`: after the resource plan render, build+render the permission plan; fold its `fetchErrors` into the INCOMPLETE handling.
- `apply.ts`: after resource `executePlan` succeeds (and before/with the `--refresh` block), `applyPermissionPlan(permItems, client)` and report `granted`/`deleted`. Include permission changes in the confirmation count.
- `get.ts`: add a `permissions-catalog` subcommand printing `loadCatalog()` as sorted `name → authId (scoped?)` lines (helps users discover valid names).

- [ ] **Step 6: Run tests + typecheck + lint**

Run: `npx vitest run && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/permissions/apply.ts src/permissions/render.ts src/commands/ tests/permission-apply.test.ts
git commit -m "feat(permissions): apply grants (PUT/DELETE) + plan/apply wiring + catalog helper"
```

---

## Task 7: Live round-trip + domain-rule tests (gated, DEV-only)

**Files:**

- Test: `tests/permission.integration.test.ts` (opt-in, `CT_LIVE=1`, **DEV instance only**)

- [ ] **Step 1: Write the gated integration test**

`describe.runIf(process.env.CT_LIVE === "1")`: against a **dev** instance, pick a disposable `group_type_role` domainId (`CT_PERM_FIXTURE_ID`), read its grants, and assert `buildPermissionPlan` for a config that declares its _current_ user-authored grants is a no-op (`toPut`/`toDelete` empty) — i.e. read→diff is drift-free. Do NOT write in the read-only assertion. A second, explicitly-guarded block may PUT+DELETE a single throwaway grant and assert idempotency, but only when `CT_LIVE_WRITE=1` AND the host is not production.

- [ ] **Step 2: Confirm it SKIPS by default**

Run: `npx vitest run tests/permission.integration.test.ts`
Expected: SKIPPED (no `CT_LIVE`). **Do not run it against the current production login.**

- [ ] **Step 3: Commit**

```bash
git add tests/permission.integration.test.ts
git commit -m "test(permissions): gated DEV-only round-trip + domain-rule checks"
```

---

## Task 8: Build asset copy, docs, example

**Files:**

- Modify: `package.json` (ensure `catalog.json` ships to `dist/permissions/`) or `tsup.config` — verify the built `ct` binary can read the catalog. If tsup doesn't copy JSON, add a copy step or `import` the JSON so it's bundled. **Verify `node dist/index.js get permissions-catalog` works after build.**
- Create: `docs/permissions.md`
- Create: `examples/permissions.config.ts`
- Modify: `README.md` (Permissions subsection; flip status bullet)

- [ ] **Step 1: Ensure the catalog ships in the build**

Confirm how `tsup` handles `src/permissions/catalog.json`. If it is not emitted next to `dist/permissions/catalog.js`, either bundle it via `import catalog from "./catalog.json" with { type: "json" }` in `catalog.ts` (and drop the `readFileSync`), or add a build copy step. Verify: `npm run build && node dist/index.js get permissions-catalog | head`.

- [ ] **Step 2: Docs + example**

`docs/permissions.md`: the two DSL functions, `module:right` names + `ct get permissions-catalog`, scoped `{right, scope}` grants, the baseline-tolerance model (system + inherited grants are invisible), domain rules, and that `group_role` domainIds are taken explicitly. `examples/permissions.config.ts`: a runnable example declaring a `groupTypeRole` with one global + one scoped grant. README: add the subsection, flip the status bullet.

- [ ] **Step 3: Verify example loads + full suite**

Run: `npm run build && node dist/index.js get permissions-catalog | head` and load the example config (config-load only — **no live writes to production**). `npx vitest run && npm run typecheck && npm run lint`.

- [ ] **Step 4: Commit**

```bash
git add package.json src/permissions/catalog.ts docs/permissions.md examples/permissions.config.ts README.md
git commit -m "docs(permissions): guide + example; ensure catalog ships in build"
```

---

## Self-Review

**Spec coverage (#13 section of the design spec):**

- DSL declares named grants on `group_role`/`group_type_role`; names resolve to authId → Tasks 1, 3, 5. ✓
- `ct plan` shows accurate grant create/delete diffs vs actual; unmanaged domain objects invisible → Tasks 5 (managed-guard), 6 (render/wiring). ✓
- `ct apply` reconciles via PUT/DELETE; re-run is a no-op → Tasks 2 (set reconciliation), 6 (apply). ✓
- Domain-rule validation + dataId/name normalization → Tasks 2 (dataId scalar→array, baseline exclusion), 5 (authId<10000, scope), 7 (live checks). ✓
- Baseline tolerance (modifiedPid −1, inherited) → Task 2. ✓
- Scope keys → dataId → Task 4. ✓

**Placeholder scan:** the only deferred item is the exact `tsup` catalog-shipping mechanism (Task 8 Step 1), which is a concrete verify-and-fix with two named options — not a vague TODO. `render.ts` formatting is described, not code-complete; the implementer follows `engine/render.ts`'s existing style.

**Type consistency:** `DomainType`/`GrantTuple`/`GrantDiff`/`RawPermission` (T2) flow into `plan.ts` (T5) and `apply.ts` (T6); `CatalogEntry`/`resolveAuthId` (T1) into T5; `DesiredPermission`/`Grant` (T3) into T5; `resolveScope` (T4) into T5. `evaluateConfig`/`loadConfig` return-shape change (T3) is threaded into both commands in the same task.
