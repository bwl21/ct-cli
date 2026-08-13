# Phase 5 — Permissions, Auto-groups, and Blueprints (#13, #14, #7)

**Status:** approved design, ready for implementation plan
**Date:** 2026-07-08
**Branch:** `feat/phase-5-permissions-autogroups-blueprints`
**Issues:** [#13 permissions-as-code](https://github.com/eqrm/ct-cli/issues/13), [#14 auto-groups](https://github.com/eqrm/ct-cli/issues/14), [#7 blueprints](https://github.com/eqrm/ct-cli/issues/7)

## Summary

Three related features, one branch, implemented in dependency order **#14 → #13 → #7**:

1. **Auto-groups (#14)** — manage dynamic groups (ruleset + status) as code, with both an opaque round-trip path and a typed query DSL.
2. **Permissions (#13)** — manage `group_role` / `group_type_role` permission grants as code.
3. **Blueprints (#7)** — prove and document parametrized campus blueprints; add examples/tests. Mostly non-code; the DSL already supports it.

All three extend one existing seam rather than introducing a parallel engine.

## Live-API findings (validated 2026-07-08 against `eqrm-dev.church.tools`, CT 3.134.1-RC1)

The instance is a **write-safe dev box**, so round-trip integration tests may genuinely PUT/DELETE. Superadmin token present.

- **Permission catalog** (`GET /permissions/global`): `module → { "right name": true | number[] }`. `true` = global right; `number[]` = the scoped `dataId`s the right is granted for.
- **Raw assignment tuple** (`GET /permissions/group_role`, `/permissions/group_type_role`) confirmed:
  ```json
  {
    "domainType": "group_role",
    "domainId": 2787,
    "authId": 113,
    "dataId": 3,
    "isInherited": false,
    "type": "grant",
    "reason": null,
    "meta": { "modifiedDate": "2026-04-21T11:50:57Z", "modifiedPid": 1 }
  }
  ```
  - `group_type_role` rows carry `authId: 10101` (> 10000). **This falsifies issue #13's claim that `authId < 10000` for `group_type_role`.** Domain rules will be derived empirically, not from the issue text.
  - `meta.modifiedPid: -1` = system-authored baseline grant (seen live on `group_type_role` domainId 8). These re-add themselves.
- **Effective/internal endpoints** (`/permissions/internal/{persons,groups}/{id}`) return `module → { "+right": value }` with **no `authId`** — they are read-only computed views, **not** the name↔authId bridge. The bridge is the legacy churchcore auth masterdata (`masterData.auth`), to be resolved as implementation step 1.
- **No dynamic groups exist** on the instance (`GET /dynamicgroups` → `[]`). A fixture dynamic group must be created on eqrm-dev during implementation to capture the `query.params.filter` JSONLogic internals and `handleMembership` contents (which OpenAPI leaves opaque) and seed the round-trip test.

### Authoritative OpenAPI shapes (pulled 2026-07-08 from `/system/runtime/swagger/openapi.json`)

- **`PermissionRequest`** (PUT/DELETE body, single object, not an array): `{ authId: int (required), dataId?: int[], isInherited?: bool, type?: "grant"|"revoke", reason?: string }`. `GET /permissions/{domainType}[/{domainId}]` → `{ data: Permission[] }` where `Permission.dataId` is a **single `int|null`**. ⇒ **GET returns `dataId` scalar, PUT sends `dataId` array** — normalize on read.
- The `authId < 10000` rule for `status`/`person`/`group_type_role` **is documented on the write body** (`PermissionRequest.authId`), and `authId 10127` is explicitly unsupported. The live `group_type_role` row with `authId 10101` is a `modifiedPid:-1` system baseline — excluded by the baseline rule below, so the write-side constraint and the read-side data do not conflict. `type:"revoke"` and `isInherited:true` are documented as valid only for the two role domains (revoke: `group_role` only).
- **Ruleset:** `GET /dynamicgroups/{id}/ruleset` → `{ data: DynamicGroupRule }` (bare). `PUT` body is **wrapped**: `{ dynamicGroupRuleSet: DynamicGroupRule }`. `DELETE` → 204. `DynamicGroupRule = { description, importance, personIdFieldName, process, query, shorty? }`. `query` is a **ChurchQuery** envelope `{ description, method: "ChurchQuery", params: { filter: {…JSONLogic…}, responseFields, … } }` — the JSONLogic tree lives in the opaque `params.filter`. ⇒ the **GET-vs-PUT difference is the `dynamicGroupRuleSet` envelope**, resolved by the normalizer.
- **Status:** `GET /dynamicgroups/{id}/status` → `{ dynamicGroupStatus: "active"|"inactive"|"manual"|"none" }`. `PUT` body `{ dynamicGroupStatus: string }`.
- **Refresh:** `POST /dynamicgroups/{id}/refresh` → `{ data: [{ groupId, created, updated, deleted, unprocessed }] }`.

## Architecture — synthetic sub-resource fields

The engine already has the pattern both features need: the opt-in `parents` set-field (`src/engine/hierarchy.ts`). `parents` is a _pseudo-field_ — not a real API column — folded into the diff on both the desired and actual sides in `build.ts`, then routed at apply time to a dedicated endpoint (`PUT/DELETE /groups/{id}/parents/{pid}`) instead of the resource body (`execute.ts` `applyParentEdges`).

Both new features are the same shape:

| Feature            | Attaches to                  | Field kind                | Actual source                                 | Write routing                                     |
| ------------------ | ---------------------------- | ------------------------- | --------------------------------------------- | ------------------------------------------------- |
| `parents` (exists) | group                        | set of keys               | `GET /groups/hierarchies`                     | `PUT/DELETE /groups/{id}/parents/{pid}`           |
| **grants** (#13)   | group-role / group-type-role | set of tuples             | `GET /permissions/{domainType}`               | `PUT/DELETE /permissions/{domainType}/{domainId}` |
| **dynamic** (#14)  | group                        | object (ruleset + status) | `GET /dynamicgroups/{id}/ruleset` + `/status` | `PUT …/ruleset` then `PUT …/status`               |

### The refactor

Generalize the one-off `applyHierarchy` fold into a small **synthetic-field registry**. Each entry:

- `fold(desired, state, actual)` — inject the normalized pseudo-field onto both the desired and actual sides for opted-in resources (mirrors `applyHierarchy`), so `computePlan`/`diffFields` handle it generically with zero changes to the diff core.
- `apply(client, state, item, changes)` — route the write to the dedicated endpoint(s) instead of the resource body (mirrors `applyParentEdges`).

`parents` becomes the first registry entry; `grants` and `dynamic` join it. This keeps `build.ts` and `execute.ts` from accreting three bespoke branches and leaves the generic diff/plan/order core (`plan.ts`, `graph.ts`, `types.ts`) untouched except for the tiers already reserved.

`graph.ts` already reserves the tiers: `group-hierarchy: 2`, `group-role: 3`, `permission: 4`, `dynamic-group: 5`.

The `assertNotPeople` guard extends to every new write path.

## Feature 1 — Auto-groups (#14)

### DSL

```ts
ct.group({
  key: "all_mainz",
  name: "Alle Mainz",
  groupTypeId: 1,
  dynamic: {
    status: "active", // "active" | "manual" | "inactive" | "none" (=demote)
    ruleset: q.and(
      // typed builder → JSONLogic (Phase 2)
      q.eq("ctgroup.campusId", campus("mainz")), // name→id resolution for var values
      q.eq("person.isArchived", false),
    ),
    // …or an opaque blob, or { ref: "./rulesets/all_mainz.json" } (Phase 1) — interchangeable
  },
});
```

- `dynamic` is an **object-field** on a group, opt-in like `parents`: `undefined` = not managed as a dynamic group; present = managed. It carries the full `RuleSet` (`{ description, shorty, personIdFieldName, importance, query, process }`) plus `status`.
- Actual read from the dedicated endpoints (`/dynamicgroups/{id}/ruleset` + `/status`), not the group body.

### Normalizer (the crux)

Runs on **both** desired and actual before diffing, so cosmetic and representational differences never produce false diffs:

- Strip cosmetic `dterm: [label, expr]` label / i18n-key subtrees (label is not evaluated by CT).
- Coerce int↔string consistently (CT is inconsistent on `var` value types).
- Ignore read-only timestamps `dynamicGroupUpdateStarted` / `dynamicGroupUpdateFinished`.
- Reconcile the GET-vs-PUT `process` nesting difference (shapes differ; cannot blindly write back what was read) — exact transform pinned against the live fixture.

Both the typed builder and an opaque blob compile to the **same normalized JSONLogic**, so they diff and round-trip identically.

### Typed query DSL (Phase 2 — opted in)

`q.and / or / not / eq / oneof / isnull / var` helpers emitting the JSONLogic tree, with key→id resolution for `var` values reusing the shared campus/group/role resolver (§ Shared resolver). Opaque blobs and `{ ref }` file references remain valid for predicates the typed layer doesn't cover yet.

### Write & ordering

- Group exists first (tier 5 applies after group tier 1), then `PUT /dynamicgroups/{id}/ruleset` → `PUT /dynamicgroups/{id}/status`.
- Demote: `status: "none"` (or `DELETE …/ruleset`) reverts to a normal group.
- **Refresh: opt-in, off by default.** Optional post-apply `POST /dynamicgroups/{id}/refresh` (per-group only — never `/dynamicgroups/refresh` all) behind a CLI flag / config opt-in. Rationale: contain blast radius; materialization is a separate concern from reconciliation. **[Approved.]**
- Managed-guard: a ruleset the tool didn't author is unmanaged unless declared.

## Feature 2 — Permissions (#13)

### DSL

```ts
ct.groupRole({
  key: "kids_lead",
  id: 51,
  grants: ["churchgroup:view group", "churchgroup:edit group members"],
});
ct.groupTypeRole({
  key: "leiter_tpl",
  id: 8,
  grants: [{ right: "churchdb:view group", scope: ["kids_area"] }],
}); // scope keys → dataId[]
```

- `grants` is a **set-field** on a role domain object. A grant is either a bare `"module:right"` string (global) or `{ right, scope: [key…] }` (scoped; scope keys resolve to `dataId[]`).
- `group_role` (per-group override) and `group_type_role` (template across a group type) are distinguished explicitly to the user via the two DSL functions.

### Name → authId resolution

DSL vocabulary is human-readable `module:right` names. Resolution to numeric `authId` uses the churchcore auth masterdata bridge (`masterData.auth`), **resolved as implementation step 1** — the REST catalog and effective endpoints expose names but not the name↔authId map. Scope keys resolve to `dataId[]` via the shared resolver.

### Diff / write

- **Set reconciliation** keyed by `(domainType, domainId, authId, sorted dataId)`.
- Actuals fetched via bulk `GET /permissions/{domainType}`, filtered to managed `domainId`s; `dataId` normalized (sorted, `null` ↔ `[]`).
- Write: `PUT` (grant) / `DELETE` (remove) per tuple; idempotent, no create/update split.
- **Baseline tolerance [approved]:** reconcile only **user-authored** grants — exclude `meta.modifiedPid: -1` (system) and `isInherited: true` rows from the diff set. Gives strict "as-code" ownership of declared grants without fighting the self-re-adding system baseline. (Rejected alternative: purely additive reconciliation that never deletes undeclared grants — inconsistent with the rest of the tool's desired-state model.)
- Managed-guard: only declared domain objects are reconciled; all others invisible.

### Validation (empirical)

Domain rules are derived from the live API + round-trip tests, not the issue text (whose `authId < 10000` rule is already falsified). To pin live before finalizing:

- Real per-domain constraints on `authId`, `revoke` (issue claims `group_role` only), and `isInherited` (issue claims the two role domains only).
- `domainId` semantics for `group_role`: whether it is the role-definition id (`/group/roles`) or a per-`(group, role)` id. The DSL's `id:` maps to `domainId`; its meaning is confirmed before the DSL is frozen.

## Feature 3 — Blueprints (#7)

The injected-context DSL (`src/config/context.ts`) is already a plain function, so parametrized blueprints and campus loops work today with no new machinery:

```ts
const kidsArea = (campus: string) => {
  ct.group({ key: `${campus}_kids_lead`, type: "local_lead", name: `${campus} · Kids Leitung` });
  ct.group({ key: `${campus}_kids_0_3`, name: `${campus} · Kids 0–3`, parents: [`${campus}_kids_lead`] });
  // …
};
for (const c of ["mainz", "berlin", "koblenz"]) {
  ct.campus({ key: c, name: `Campus ${c}` });
  kidsArea(c);
}
```

Deliverables (mostly non-code):

- An example `kidsArea(campus)` blueprint + a test proving one blueprint instantiated across ≥2 campuses yields the correct **ordered** plan.
- A dynamic auto-group inside a blueprint reconciling idempotently (exercises #14).
- Docs (README / a short blueprint guide).
- **No new abstraction** unless a helper obviously earns its place (YAGNI). The value delivered is the proof + examples that the function-based DSL scales.

## Shared resolver

A single key/name → CT-id resolver used by:

- Auto-group typed `var` values (`campus("mainz")` → campus id, group/role by key → id).
- Permission scope keys → `dataId[]`.

It resolves logical keys against the state file (managed set) and, where needed, against live catalog data (campuses, roles). Centralizing avoids three divergent lookups.

## Testing

- **Unit:** normalizers (JSONLogic `dterm` stripping, int/string coercion, timestamp removal, GET↔PUT `process` transform); permission set reconciliation (tuple keying, `dataId` normalization, baseline/inherited exclusion); name→authId and key→dataId resolution; typed-query → JSONLogic compilation.
- **Round-trip integration (opt-in, env-gated — they write to eqrm-dev):** read → normalize → write-back = no-op for a real dynamic group (fixture created during implementation) and for a permission grant set. Pins the "preliminary / subject to change" APIs.

## Sequencing

One branch. Implement **#14 → #13 → #7**. #14 and #13 are independent; #7 lands last because its DoD exercises both.

## Open items to resolve during implementation (all live-resolvable on eqrm-dev)

1. **Name↔authId bridge** (churchcore auth masterdata) — permissions step 1. **Still open:** no REST endpoint (`/permissions/masterdata`, `/permissions` both 404; legacy `?q=churchcore/ajax&func=getMasterData` needs correct params). Resolve via the legacy churchcore masterdata call or `cc_authview.js`'s source.
2. `group_role` `domainId` semantics (role-def id vs per-(group,role) id) — freeze permission DSL after. **Still open.**
3. `query.params.filter` JSONLogic internals + `handleMembership` contents — **fixture-only** (OpenAPI leaves them opaque); captured by the #14 fixture task.

**Resolved by the 2026-07-08 OpenAPI probe** (see "Authoritative OpenAPI shapes" above): domain validation rules (`authId<10000`, `revoke`/`isInherited` domains); `dataId` GET-scalar-vs-PUT-array; ruleset GET-bare-vs-PUT-`dynamicGroupRuleSet`-wrapped envelope; status/refresh bodies.
