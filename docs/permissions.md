# Permissions (`ct.groupRole` / `ct.groupTypeRole`)

Declare ChurchTools permission grants — group-role and group-type-role rights —
as code, and reconcile them idempotently with the same `ct plan` / `ct apply`
workflow used for structural resources (issue #13).

## The two DSL functions

```ts
export default (ct) => {
  ct.groupTypeRole({
    key: "leiter_tpl",             // logical key (unique across the whole config)
    groupType: "ministry_team",    // domain BY NAME — resolved to the domainId per host (#20)
    grants: [
      "churchgroup:view group",                                    // unscoped
      { right: "churchgroup:view group", scope: ["kids_area"] },   // scoped
    ],
  });

  ct.groupRole({
    key: "kids_lead_grant",
    group: "kids_area",      // domain BY (group, role) — resolved to the pairing domainId per host (#25)
    role: "Leiter",          // (or keep the numeric escape hatch: `id: 2882`)
    // "edit group memberships of group" is a scoped right, so it takes a `scope: [...]`.
    grants: [{ right: "churchgroup:edit group memberships of group", scope: ["kids_area"] }],
  });
};
```

Both take `{ key, <domain>, grants }`, where `<domain>` is either a logical
reference or a numeric `id`:

- **`key`** — the logical key, unique across the whole config (shared
  namespace with every other resource type).
- **domain** — the permission domain object. Declare it **by reference** (the
  portable form, #20) or **by numeric `id`** (the escape hatch):
  - `ct.groupTypeRole` — `groupType: "<name>"` resolves against the live
    group-type catalog per host, or `id: <domainId>` targets one directly.
  - `ct.groupRole` — `group: "<key>", role: "<name>"` resolves the (group,
    role) pair to its pairing domainId per host (#25), or `id: <domainId>`
    targets one directly. The group must be **managed** (declared via `ct.group`
    or adopted into state) and already created — a same-run group is rejected
    (its pairing id is only known once it exists; pass a numeric `id` there).
    Declaring both a logical form and a numeric `id` is a conflict and throws.
    See "domainId semantics" for the resolution assumption still to be
    confirmed live.
- **`grants`** — an array of `Grant`s, each either:
  - a bare string, `"module:right"` — an **unscoped** grant, or
  - an object `{ right: "module:right", scope: (string | number)[] }` — a
    **scoped** grant, where each `scope` entry is either a logical key of a
    managed group, or a raw numeric `dataId` (the escape hatch, #49 — see
    "Scope resolution" below).

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

## Catalog lifecycle & staleness (#25)

The catalog (`src/permissions/catalog.json`) is a snapshot of one instance's
permission master data, captured at a specific ChurchTools version. Two things
keep it honest:

**Regeneration — one command.** Point it at a live instance and it rewrites
`catalog.json` (rights + a fresh `$meta` provenance stamp):

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

It logs in, calls the legacy `POST /index.php?q=churchauth/ajax` `func=getMasterData`
endpoint (the only source of the name↔authId map — see
`src/permissions/README.md`), records the instance's CT version, and writes the
file. It performs a single **read**; it never writes to the instance. Review
the `git diff` before committing.

**Staleness & unknown rights — `ct plan` warns (never fails).** `$meta.ctVersion`
records the version the catalog was captured from. On every `plan`/`apply`:

- If the live instance's CT version differs from `$meta.ctVersion`, `ct plan`
  prints a warning — right names/authIds/scopeFields may have drifted;
  regenerate to be sure.
- If a **live grant carries an `authId` the catalog cannot name** (a stale or
  foreign right), `ct plan` names the `authId` + domain and **leaves the grant
  untouched** — it is deliberately kept *out* of the diff so `ct apply` never
  revokes a right it cannot even describe. This is idempotent: the unknown row
  is excluded every run, so it neither churns nor silently disappears.

Both are warnings, not errors: the plan still runs and the exit code stays
success. Regenerating the catalog (above) is the fix for both.

## `domainId` semantics

The two DSL functions manage two different ChurchTools "domain types," and
`id` means something different for each:

- **`group_type_role`** (`ct.groupTypeRole`) — the domain is the **group type's
  own id** (the same id you'd pass as `groupTypeId` on `ct.group`). It scopes the
  grant to "every role holder of this group type." Declare it portably as
  `groupType: "<name>"` (resolved per host, #20) or directly as `id: <domainId>`.
- **`group_role`** (`ct.groupRole`) — the domain is the **internal
  (group, role) pairing's own id** — a ChurchTools-internal id for one
  specific group's specific role, *not* the group's id and *not* the role's
  id. Declare it portably as `group: "<key>", role: "<name>"` (resolved per
  host, #25) or directly as `id: <domainId>`.

  > **ASSUMPTION — verify once on a live instance (`eqrm-dev`).** The reference
  > form resolves by reading the group's own role list
  > (`GET /groups/{groupId}/roles`) and taking the matched role row's `id` as
  > the pairing domainId. Neither the endpoint nor the field is confirmed
  > against a live instance (the assumption is pinned in a unit test and in a
  > prominent comment in `src/resolve/resolver.ts`). If a live check shows the
  > pairing id lives in a different field or endpoint, change the two
  > constants at the top of `resolver.ts` — call sites don't change. Until
  > confirmed, the numeric `id:` escape hatch is the guaranteed-correct path:
  > find the id via the ChurchTools permission editor / an existing
  > `GET /permissions/group_role` response, and hardcode it like any other
  > domainId.

Resolution runs in `buildPermissionPlan` (`src/permissions/plan.ts`): a numeric
`id` passes straight through; a `groupType` reference resolves against the live
catalog, and a `group` + `role` pair against the group's role list. After
resolution, two declarations that resolve to the **same** `(domainType,
domainId)` are rejected (they would otherwise diff against each other's grants
forever) — even if one used a name and the other a raw id.

## Scope resolution

A scoped grant's `scope: [...]` is a list where each entry is either a
**logical key of a group managed by this tool** (declared via `ct.group` or
adopted into state), or a **raw numeric `dataId`** (the escape hatch — see
below). String entries are resolved against **desired ∪ state**
(`src/permissions/scope.ts`):

- A key already in state resolves to that group's `dataId`.
- A key **declared in this config but not yet created** resolves to a *pending*
  target: the plan renders it as `scope=[<key> (created this apply)]`, and its
  real `dataId` is filled in at apply time — so a config can declare a group AND
  a grant scoped to it and still plan/apply in one run (no bootstrap deadlock).
- A key that is neither in state nor declared throws:

  ```
  Scope key "kids_area" does not resolve to a managed group. Declare/adopt it,
  use a group already under management, or pass a raw numeric dataId if this
  right's scope is not a group (see the catalog's scopeField).
  ```

The requirement that scope targets be tool-visible is deliberate: so `ct plan`
can show what a grant resolves to, and so renaming/re-keying a group doesn't
silently orphan a grant's scope.

**Re-resolution at apply time.** Every scoped tuple resolved from a logical
group key retains its symbolic scope key. Immediately before grants are
written (after the resource tier has run), each key is re-resolved against the
post-execute state. This means a group *created* or *recreated* in the same
apply always gets its grant written with its fresh `dataId`, never a pending
placeholder or a stale, dangling id.

### Numeric scope escape hatch (#49)

Not every scoped right's `scope` dimension is a **group**. The catalog's
`scopeField` names the actual ChurchTools data-field a scoped right applies
to (`src/permissions/catalog.json`) — for most scoped rights that field is
`"cdb_gruppe"` (a group), but some rights scope by something else entirely,
e.g.:

- `churchdb:view comments` → `scopeField: "cdb_comment_viewer"`
- `churchdb:security level view own data` / `edit own data` → `scopeField:
  "cc_securitylevel"`

For these, a `dataId` like `1`, `2`, `3` names a security level or a
comment-viewer bucket — **not** a group — so `GET /groups/{1,2,3}` 404s and
there is no logical/managed key to reference it by. A `scope` array entry may
therefore be a plain number instead of a string:

```ts
{ right: "churchdb:security level view own data", scope: [1, 2, 3, 5] },
```

Numeric entries pass straight through with no state lookup, no pending
resolution, and no re-resolution at apply time (their `dataId` is already
final). They can be freely mixed with logical group keys in the same `scope`
array. `ct adopt grants` emits this form automatically for any scoped right
whose `scopeField` is not the group dimension (see below) — never a `ct adopt
group <id>` hint for a dataId that was never a group.

## Adopting existing grants — `ct adopt grants <domainType> <domainId>`

To bring an instance's existing rights under management without hand-transcribing
them, read the live rows and emit a paste-ready config block:

```bash
ct adopt grants group_type_role 42   # or: group_role, and the hyphenated group-type-role
```

It fetches `GET /permissions/<domainType>/<domainId>`, runs the rows through the
**same** normalization the planner uses (`normalizeActual`), and prints a
`ct.groupRole` / `ct.groupTypeRole` block whose every emitted grant is guaranteed
to be accepted by `ct plan` (the round trip is locked by tests):

- **Excluded, as reconciliation excludes them:** the system baseline
  (`meta.modifiedPid === -1`) and inherited rows.
- **Revoke/deny rows are preserved, not emitted.** The reconciler never deletes a
  deny it did not author; if any exist, the block ends with a `NOTE` comment
  saying so (authoring denies as config is a separate, unshipped feature).
- **`authId` → `module:right` via the catalog** (reverse lookup). An `authId`
  with no catalog entry becomes a `WARNING` comment (regenerate the catalog or add
  the right by hand) rather than failing the whole adoption.
- **Scoped rights** are resolved by the right's actual `scopeField`
  (#49) — only rights scoped by the **group** dimension
  (`scopeField: "cdb_gruppe"`) are round-tripped as logical group refs; every
  other scope dimension is emitted as the [numeric escape
  hatch](#numeric-scope-escape-hatch-49) instead:
  - **Group-scoped** (`cdb_gruppe`): if the `dataId` matches a group
    **managed in your state file**, the scope is emitted as that group's
    logical key (`scope: ["kids"]`). If it is unmanaged, you get a
    clearly-marked placeholder comment telling you to `ct adopt group <id>`
    first — scope keys must be state keys (see [Scope
    resolution](#scope-resolution)).
  - **Any other scope dimension** (`cc_securitylevel`, `cdb_comment_viewer`,
    …): there is no group to adopt, so the `dataId`(s) are emitted directly
    as a numeric `scope: [1, 2, 3]` — always an active line, with a comment
    naming the right's actual scope dimension. `ct adopt group <id>` is never
    suggested for these.
  - A scoped right granted **globally** in CT (row with no `dataId`) is a
    `WARNING` comment either way — the DSL deliberately cannot declare a
    global grant of a scoped right.
- **Not-writable rights become `NOTE` comments.** On `group_type_role`, rights
  with `authId >= 10000` (the `churchdb:+…` family) are readable via inheritance
  but rejected at plan time (see "Domain rules" below), so they are never
  emitted as grants.
- **Only `group_role` / `group_type_role`** are valid; people domains are
  refused (the same hard boundary as everywhere else).

> **Warning — comment-only grants are pending revocations.** Reconciliation is
> set-based: a live grant absent from the pasted declaration lands in
> `toDelete`. So any grant the adopter could only express as a `WARNING`/`NOTE`
> comment is still **live on the instance but missing from your config** —
> applying the block as-is will **revoke** it. The block prints a header saying
> exactly how many such grants exist; resolve every one (adopt the group,
> regenerate the catalog, …) before `ct apply`. `ct plan` is only a no-op once
> no comment-only grants remain.

Grants are **not** a state-tracked resource, so this prints config **only** — it
never writes the state file (unlike `ct adopt <type> <id>`). Pick a real logical
`key` (the emitted one is a rename-to-taste placeholder), paste into your config,
and `ct plan`.

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
