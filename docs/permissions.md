# Permissions (`ct.groupRole` / `ct.groupTypeRole`)

Declare ChurchTools permission grants — group-role and group-type-role rights —
as code, and reconcile them idempotently with the same `ct plan` / `ct apply`
workflow used for structural resources (issue #13).

## The two DSL functions

```ts
export default (ct) => {
  ct.groupTypeRole({
    key: "leiter_tpl",       // logical key (unique across the whole config)
    id: 8,                   // the domainId — see "domainId semantics" below
    grants: [
      "churchgroup:view group",                                    // unscoped
      { right: "churchgroup:view group", scope: ["kids_area"] },   // scoped
    ],
  });

  ct.groupRole({
    key: "kids_lead_grant",
    id: 2882,                // the internal (group, role) domainId — see below
    // "edit group memberships of group" is a scoped right, so it takes a `scope: [...]`.
    grants: [{ right: "churchgroup:edit group memberships of group", scope: ["kids_area"] }],
  });
};
```

Both take the same shape, `{ key, id, grants }`:

- **`key`** — the logical key, unique across the whole config (shared
  namespace with every other resource type).
- **`id`** — the explicit **domainId** of the permission domain object. This
  tool does not look it up for you; you supply it directly (see
  "domainId semantics" below).
- **`grants`** — an array of `Grant`s, each either:
  - a bare string, `"module:right"` — an **unscoped** grant, or
  - an object `{ right: "module:right", scope: string[] }` — a **scoped**
    grant, where `scope` is a list of logical keys of managed groups
    (resolved to their ChurchTools `dataId`s at plan time — see "Scope
    resolution" below).

## Discovering right names — `ct get permissions-catalog`

Right names are validated against a static, offline catalog (`module:right` →
`authId`), because the name↔authId mapping is not exposed by the ChurchTools
REST API (see `src/permissions/README.md` for how it was captured). List it:

```bash
ct get permissions-catalog
# churchgroup:view group -> 1104 (scoped)
# churchcore:administer settings -> 1 (unscoped)
# ...
```

Each line shows the name, its numeric `authId`, and whether it's `scoped`
(accepts a `scope: [...]` — i.e. the catalog entry has a non-null
`scopeField`) or `unscoped`. An unknown name throws a clear error at
**plan/apply time** — inside `desiredTuples` (`src/permissions/plan.ts`),
when grants are resolved to tuples against the catalog, after the authed
fetch — with a "did you mean" hint drawn from same-module names. (Config
evaluation only checks a grant's *shape*: `module:right` string or
`{ right, scope }`; it does not resolve the name against the catalog.)

## `domainId` semantics

The two DSL functions manage two different ChurchTools "domain types," and
`id` means something different for each:

- **`group_type_role`** (`ct.groupTypeRole`) — `id` is the **group type's own
  id** (the same id you'd pass as `groupTypeId` on `ct.group`). It scopes the
  grant to "every role holder of this group type."
- **`group_role`** (`ct.groupRole`) — `id` is the **internal
  (group, role) pairing's own id** — a ChurchTools-internal id for one
  specific group's specific role, *not* the group's id and *not* the role's
  id. There is no lookup helper for this in the CLI; find it via the
  ChurchTools permission editor / an existing `GET /permissions/group_role`
  response for a group+role you already have, and hardcode it in the config
  like any other domainId.

## Scope resolution

A scoped grant's `scope: [...]` is a list of **logical keys of groups managed
by this tool** (declared via `ct.group` or adopted into state) — not raw
ChurchTools ids. At plan time each key is resolved to that group's `dataId`
via the state file; a key that isn't a managed group throws:

```
Scope key "kids_area" does not resolve to a managed group. Declare/adopt it,
or use a group already under management.
```

This is a deliberate constraint (see `src/permissions/scope.ts`): scope
targets must be tool-visible so `ct plan` can show what a grant actually
resolves to, and so renaming/re-keying a group doesn't silently orphan a
grant's scope.

## Domain rules (validated, throw on violation)

- **`group_type_role` requires `authId < 10000`.** Rights with `authId >=
  10000` are not writable through this domain type in ChurchTools; declaring
  one under `ct.groupTypeRole` throws at plan/evaluation time
  (`src/permissions/plan.ts`, `desiredTuples`). Use `ct.groupRole` for those
  rights instead.
- **Revocation is a later extension, not exposed yet.** `GrantTuple.type` is
  typed as `"grant" | "revoke"`, but the DSL and `desiredTuples` currently
  only ever *emit* `"grant"` tuples — there is no config-level way to declare
  an explicit `type: "revoke"` grant today (`type: "revoke"` is reserved for
  a future `group_role`-only extension). Removing a grant's entry from the
  config still works as expected: the reconciler's set-diff (see below)
  computes it as a tuple to **delete**, and `ct apply` issues a `DELETE`
  against ChurchTools for it — you just don't author `"revoke"` yourself.

## The baseline-tolerance model

`ct plan` and `ct apply` reconcile only the grants **you author** on a
domainId — never the platform's own bookkeeping. `normalizeActual`
(`src/permissions/grants.ts`) filters two kinds of rows out of every actual
fetch before diffing, making both invisible to reconciliation:

- **System baseline rows** — any row with `meta.modifiedPid === -1`. These
  are ChurchTools' own self-re-adding defaults; they are never proposed for
  deletion and never conflict with a desired grant.
- **Inherited rows** — any row with `isInherited: true`. These come from
  hierarchy/role inheritance, not this domainId's own grant table; they are
  not owned here either.

Combined with the **managed-guard** (`buildPermissionPlan` only ever surfaces
the `domainId`s you've declared — a bulk `GET /permissions/{domainType}`
response is filtered down to just those before diffing), this means:
unmanaged domains, system defaults, and inherited grants are all completely
invisible to `ct plan`/`ct apply` — only the grant set you explicitly declare
for a domainId you explicitly declare is ever read, diffed, or written.

## Set reconciliation

A grant's identity for diffing purposes is `(authId, sorted dataId[], type)`
(`tupleKey` in `src/permissions/grants.ts`). `ct plan` computes
`toPut`/`toDelete` as a straightforward set difference between desired and
(filtered) actual tuples; `ct apply` issues one `PUT` per `toPut` tuple and
one `DELETE` per `toDelete` tuple against
`/permissions/{domainType}/{domainId}`. Re-running `ct apply` against an
unchanged instance diffs to empty and issues no requests — the reconciliation
is idempotent.

## Example

See [`examples/permissions.config.ts`](../examples/permissions.config.ts) for
a runnable `ct.groupTypeRole` declaration with one global grant and one
scoped grant.
