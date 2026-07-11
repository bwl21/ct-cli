# Auto-groups (dynamic groups)

ChurchTools "dynamic groups" (aka auto-groups) compute their membership from a
saved query ("ruleset") instead of manual add/remove. `ct-cli` manages a
group's dynamic-group configuration — the ruleset and its status — as an
opt-in extra on `ct.group(...)`, diffed and applied exactly like any other
managed field.

> People are still never touched. `ct-cli` writes the _ruleset that computes_
> membership, never a person↔group relationship directly.

## The `dynamic` block

```ts
ct.group({
  key: "all_mainz",
  name: "Alle Mainz",
  groupTypeId: 1,
  dynamic: {
    status: "manual", // "active" | "manual" | "inactive" | "none"
    ruleset: {/* RuleSet object | { ref: "./x.json" } | churchQuery(...) build */},
  },
});
```

`dynamic` is **opt-in** and only valid on `ct.group(...)` — declaring it on
any other resource type throws at config-load time. Omitting it entirely
(`undefined`) means "not a dynamic group", mirroring how `parents` works for
group hierarchy. Validation lives in `src/config/context.ts` (`toDesired`).

### `status`

- `active` — ChurchTools recomputes membership automatically.
- `manual` — the ruleset is stored, but membership is only recomputed when
  explicitly triggered (`ct apply --refresh`, or manually in the ChurchTools
  UI).
- `inactive` — the ruleset is stored but paused.
- `none` — demotes the group back to an ordinary (non-dynamic) group. Keep
  the `dynamic` block (the DSL still requires a `ruleset` object — `{}` is
  fine, since its content is irrelevant on demote) and set
  `status: "none"`. `ct apply` responds with `DELETE
/dynamicgroups/{id}/ruleset` followed by `PUT /dynamicgroups/{id}/status`
  with `{ dynamicGroupStatus: "none" }`.

Statuses are validated against exactly `["active", "inactive", "manual",
"none"]` in `src/config/context.ts`.

### Ordering: the group must exist first

A group must exist before it can carry a ruleset. You never have to sequence
this yourself: `dynamic` is a synthetic field on `group` (like `parents`),
not a separate resource with its own tier in `TYPE_TIER`
(`src/engine/graph.ts`). Its ruleset/status writes happen inline, as part of
the group's own tier-1 apply, after the group itself has been
created/updated — so `ct apply` always writes against the group's real
(possibly just-created) id.

## Supplying a ruleset — three ways

1. **Inline `RuleSet` object literal** — write the object by hand (e.g.
   copy-pasted from `ct get raw /dynamicgroups/{id}/ruleset` and trimmed).
2. **`{ ref: "./relative/path.json" }`** — a file reference. Resolved
   relative to the process CWD at fold time by `resolveRulesetRef`
   (`src/engine/dynamic.ts`); the referenced file's JSON contents are used
   verbatim as the ruleset. Handy for pasting an exported ruleset without
   inlining a huge JSONLogic tree into the `.ts` config. A captured file
   embeds that instance's numeric ids — see [Portable snapshot files across
   environments](#portable-snapshot-files-across-environments-76) to make it
   drive dev and prod from one file.
3. **Typed query builder** — build the JSONLogic filter with `q` and wrap it
   with `churchQuery` (`src/config/query.ts`, re-exported from
   `src/config/context.ts`).

All three ultimately produce a plain JS object with the same shape; which one
you pick is purely a matter of how you want to author/version it.

### Portable snapshot files across environments (#76)

A ruleset **captured from a live instance** — `ct adopt group --with-dynamic`, or
a hand-exported `{ ref: "./rulesets/<key>.json" }` file — is byte-faithful by
design: the query filters embed _that instance's_ numeric ids (e.g.
`ctgroup.id ∈ [148, 1228, 32]`, `role.id ∈ [16, 84]`). Those ids are
**instance-specific**. Point the same file at another environment and CT accepts
it, but the ids resolve to different or nonexistent entities there, so the
auto-group computes the wrong (usually empty) membership. This is the one place a
snapshot is _not_ portable — everything else in the config is logical-ref
portable (#20/#22).

To make a snapshot portable, replace an **entity id in a query `var` position**
with a logical reference. The resolver rewrites references anywhere inside the
ruleset to the per-host id at plan time, and the resolved form still
normalizes/diffs **byte-faithfully** against CT (so a matching instance stays a
no-op — it does not re-`PUT` on every apply). Two equivalent ways to author it:

- **Re-author with the typed builder** (preferred for readability):
  `churchQuery(q.oneof("ctgroup.id", [ref.group("jugend-mainz"), ref.group("jugend-berlin")]))`.
- **Edit the JSON file in place** — a reference serialises to a plain,
  hand-editable JSON leaf, so in a captured `rulesets/<key>.json` you can swap a
  raw id for a marker directly:

  ```jsonc
  // before (prod-specific, not portable):
  { "==": [{ "var": "ctgroup.campusId" }, 148] }
  // after (portable — resolves to each host's Mainz campus id at plan time):
  { "==": [{ "var": "ctgroup.campusId" }, { "__ctRef": true, "kind": "campus", "key": "mainz" }] }
  ```

  Marker `kind`s: `campus`, `group`, `group-type`, `role-def` (`key` is the
  logical key / slug). See `ref` in `src/resolve/refs.ts`.

**Escape hatch — raw numeric ids pass through untouched.** A query that
references an _operational_ group outside the managed scaffold (no logical key to
resolve against) can keep the plain number; you then own its per-environment
correctness. This mirrors the permission scope escape hatch (#49): prefer a
reference, fall back to a number where no managed key exists.

#### Auto-rewrite on capture: `--portable-rulesets` (opt-in, #76)

Rather than hand-editing markers into a freshly captured file, let adopt do it:

```sh
ct adopt group <id> --with-dynamic --portable-rulesets
```

With the flag, `ct adopt group --with-dynamic` runs the captured (normalized)
ruleset through `portablizeRuleset` (`src/config/query-refs.ts`) before writing
`rulesets/<key>.json`: every numeric id sitting in a known ChurchQuery `var`
position that maps to a **managed** logical key is rewritten to its `{ __ctRef }`
marker; every other id is left numeric. The `var → RefKind` catalog it keys off
(`VAR_REF_KINDS`) is:

| ChurchQuery `var`      | marker `kind` | source catalog / state          |
| ---------------------- | ------------- | ------------------------------- |
| `ctgroup.id`           | `group`       | managed state (no REST catalog) |
| `ctgroup.campusId`     | `campus`      | `/campuses`                     |
| `person.campusId`      | `campus`      | `/campuses`                     |
| `ctgroup.groupTypeId`  | `group-type`  | `/group/grouptypes`             |
| `role.id`              | `role-def`    | `/group/roles`                  |

`role.id` maps to **`role-def`** (the global role catalog `/group/roles`, a
single numeric id) — not `group-role`, which is a compound (group, role)
permission _domain_ a lone `role.id` number cannot express.

The flag is **default OFF**: auto-rewriting an id you _thought_ was managed would
silently change query semantics, so you opt in per invocation. Ids that don't map
to a managed key (an operational group outside the scaffold, or the catalog-less
`ctgroup.groupStatusId`, #67) stay numeric — the escape hatch — and adopt emits a
warning naming the file:

```text
! left 2 unmanaged id(s) numeric in jugend.json — operational/unmanaged refs, not portable (escape hatch)
```

> **Interim caveat (when NOT using `--portable-rulesets`):** applying a
> raw-id prod snapshot to a _different_ environment is mechanically fine (CT
> accepts it; unknown ids → empty matches) but **semantically wrong** for that
> environment's memberships. Treat it as a known, documented gap — not a silent
> one — when rehearsing prod configs against dev.

### The `RuleSet` shape

Real ChurchTools rulesets (captured from `GET /dynamicgroups/{id}/ruleset` —
see `tests/fixtures/dynamic/README.md`) look like:

```jsonc
{
  "description": "Alle aktiven Personen in Mainz", // human label — lives HERE, not inside `query`
  "shorty": "Autom. Mitgliedschaft Alle Mainz",
  "personIdFieldName": "person.id",
  "importance": 0,
  "query": { "method": "ChurchQuery", "params": { "...": "..." } },
  "process": {},
}
```

`description` and `shorty` are fields **on the ruleset object itself** — a
sibling of `query`, not an argument to `churchQuery(...)`.

### Typed query builder (`q` / `churchQuery`)

`q` (`src/config/query.ts`) emits a JSONLogic tree:

| helper                     | emits                                   |
| -------------------------- | --------------------------------------- |
| `q.and(...nodes)`          | `{ and: nodes }`                        |
| `q.or(...nodes)`           | `{ or: nodes }`                         |
| `q.not(node)`              | `{ "!": [node] }`                       |
| `q.var(name)`              | `{ var: name }`                         |
| `q.eq(varName, value)`     | `{ "==": [{ var: varName }, value] }`   |
| `q.oneof(varName, values)` | `{ oneof: [{ var: varName }, values] }` |
| `q.isnull(varName)`        | `{ isnull: [{ var: varName }] }`        |

`var` values may be **logical references** or **raw ids**. Prefer a reference so
the ruleset is portable across hosts (#20): `q.eq("ctgroup.campusId",
ref.campus("mainz"))` — the per-host resolver fills in that instance's campus id
at plan time (and, for a campus created in the same run, at apply time). `ref` is
re-exported from `src/config/context.js` alongside `q`/`churchQuery`. The numeric
escape hatch still works — pass a plain number to target one instance's id
directly. References resolve deep inside the ruleset, so any `var` value works.

`churchQuery(filter, opts?)` wraps a JSONLogic filter tree in the same
envelope shape ChurchTools itself returns:

```ts
{
  method: "ChurchQuery",
  params: {
    groupBy: opts.groupBy ?? ["person.id"],
    filter,
    primaryEntityAlias: opts.primaryEntityAlias ?? "person",
    responseFields: opts.responseFields ?? ["person.id", "person.firstName", "person.lastName"],
  },
}
```

**`churchQuery` does not take a `description` argument** — pass `description`
as a field on the ruleset object instead (see the shape above). `opts` only
covers `primaryEntityAlias` / `responseFields` / `groupBy`, for a query keyed
on something other than `person.id`.

```ts
import { q, churchQuery, ref } from "../src/config/context.js";

const ruleset = {
  description: "Alle aktiven Personen in Mainz",
  shorty: "Autom. Mitgliedschaft Alle Mainz",
  importance: 0,
  personIdFieldName: "person.id",
  process: {},
  // campus BY NAME — resolved to the per-host id at plan time (numeric ids still work too).
  query: churchQuery(q.and(q.eq("ctgroup.campusId", ref.campus("mainz")), q.eq("person.isArchived", false))),
};
```

## Drift, normalization, and no-op re-applies

ChurchTools' stored rulesets carry cosmetic noise that would otherwise show
up as permanent phantom diffs on every `ct plan`:

- **`dterm: [label, expr]` wrappers** — a cosmetic UI label around a
  subtree. Never evaluated by ChurchTools; stripped down to `expr`.
- **int/string inconsistency** — the same logical id shows up as both `1`
  and `"1"` across (and even within) a single ruleset. Numeric-looking
  strings inside the `query` subtree are coerced to numbers.
- **read-only fields** (`dynamicGroupUpdateStarted`,
  `dynamicGroupUpdateFinished`) and the transport envelopes — `GET` returns a
  single-element `[RuleSet]` array; `PUT` takes `{ dynamicGroupRuleSet: [RuleSet] }`
  (live-decoded, #77; see `putRulesetBody` in `src/engine/dynamic.ts`) — are
  unwrapped/dropped before comparison.

Both the desired side (your config) and the actual side (fetched from
ChurchTools) are run through the same `normalizeRuleset`
(`src/engine/dynamic.ts`) before diffing. That means: declare a ruleset,
`ct apply` it, then `ct plan` again — no drift, only real content changes
produce a diff. Normalization is scoped to the `query` subtree only; it's
never applied to ruleset-level string fields like `description`/`shorty`, so
a numeric-looking label (e.g. a `description` of `"2024"`) is never silently
retyped to a number and corrupted on write-back.

**Pinned assumption (#36):** the no-op-plan property above relies on every
RuleSet-level field OTHER than `query` (`description`, `shorty`, `importance`,
`personIdFieldName`, `process`) round-tripping through ChurchTools
byte-for-byte on `PUT`/`GET` — `normalizeRuleset` does not canonicalize them.
This is pinned by a live-gated test in `tests/dynamic.integration.test.ts`
(see `tests/fixtures/dynamic/README.md` for how to run it and what to do if
it fails); it is skipped by default and requires an explicit opt-in against a
dev instance.

## Managed guard: undeclared groups stay invisible

Dynamic-group state is only ever fetched for a group that is **both**: (a)
already under state management, and (b) opted in via a `dynamic` block in
the _current_ config (`dynamicField.fold` in `src/engine/synthetic.ts`). A
managed group without a `dynamic` block is never queried for its
ruleset/status — any auto-group configuration it happens to have in
ChurchTools stays completely invisible to `ct plan` / `ct apply`, exactly
like any other resource this tool doesn't manage.

## Applying and refreshing membership

`ct apply` writes the ruleset (`PUT /dynamicgroups/{id}/ruleset`) and status
(`PUT /dynamicgroups/{id}/status`) as part of the same run as everything
else — but this does **not** recompute membership. Recomputation happens on
ChurchTools' own schedule for `active` groups, or must be explicitly
triggered.

Pass `--refresh` to `ct apply` to opt in to a post-apply refresh: it POSTs
`/dynamicgroups/{id}/refresh` for each dynamic group whose `dynamic` field
actually changed in this run.

```bash
ct apply --refresh
```

This is deliberately **per-group only** (`refreshChangedDynamicGroups` in
`src/commands/apply.ts`) — the all-groups `/dynamicgroups/refresh` endpoint
has a huge blast radius and is never called from here. A change to one
group's ruleset never triggers a recompute of every dynamic group in the
instance.

## Full example

See [`examples/dynamic-group.config.ts`](../examples/dynamic-group.config.ts)
for a runnable config declaring a campus and a dynamic group built with the
typed query DSL.
