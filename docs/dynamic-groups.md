# Auto-groups (dynamic groups)

ChurchTools "dynamic groups" (aka auto-groups) compute their membership from a
saved query ("ruleset") instead of manual add/remove. `ct-cli` manages a
group's dynamic-group configuration — the ruleset and its status — as an
opt-in extra on `ct.group(...)`, diffed and applied exactly like any other
managed field.

> People are still never touched. `ct-cli` writes the *ruleset that computes*
> membership, never a person↔group relationship directly.

## The `dynamic` block

```ts
ct.group({
  key: "all_mainz",
  name: "Alle Mainz",
  groupTypeId: 1,
  dynamic: {
    status: "manual", // "active" | "manual" | "inactive" | "none"
    ruleset: {
      /* RuleSet object | { ref: "./x.json" } | churchQuery(...) build */
    },
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
   inlining a huge JSONLogic tree into the `.ts` config.
3. **Typed query builder** — build the JSONLogic filter with `q` and wrap it
   with `churchQuery` (`src/config/query.ts`, re-exported from
   `src/config/context.ts`).

All three ultimately produce a plain JS object with the same shape; which one
you pick is purely a matter of how you want to author/version it.

### The `RuleSet` shape

Real ChurchTools rulesets (captured from `GET /dynamicgroups/{id}/ruleset` —
see `tests/fixtures/dynamic/README.md`) look like:

```jsonc
{
  "description": "Alle aktiven Personen in Mainz", // human label — lives HERE, not inside `query`
  "shorty": "Autom. Mitgliedschaft Alle Mainz",
  "personIdFieldName": "person.id",
  "importance": 0,
  "query": { "method": "ChurchQuery", "params": { "..." : "..." } },
  "process": {},
}
```

`description` and `shorty` are fields **on the ruleset object itself** — a
sibling of `query`, not an argument to `churchQuery(...)`.

### Typed query builder (`q` / `churchQuery`)

`q` (`src/config/query.ts`) emits a JSONLogic tree:

| helper                        | emits                                    |
| ------------------------------ | ----------------------------------------- |
| `q.and(...nodes)`              | `{ and: nodes }`                          |
| `q.or(...nodes)`               | `{ or: nodes }`                           |
| `q.not(node)`                  | `{ "!": [node] }`                         |
| `q.var(name)`                  | `{ var: name }`                           |
| `q.eq(varName, value)`         | `{ "==": [{ var: varName }, value] }`     |
| `q.oneof(varName, values)`     | `{ oneof: [{ var: varName }, values] }`   |
| `q.isnull(varName)`            | `{ isnull: [{ var: varName }] }`          |

`var` values are **raw ChurchTools ids** (e.g. `ctgroup.campusId`) — resolve
any key → id lookup at config-build time, before calling `q.eq`/`q.oneof`,
and pass the number.

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
import { q, churchQuery } from "../src/config/context.js";

const ruleset = {
  description: "Alle aktiven Personen in Mainz",
  shorty: "Autom. Mitgliedschaft Alle Mainz",
  importance: 0,
  personIdFieldName: "person.id",
  process: {},
  query: churchQuery(q.and(q.eq("ctgroup.campusId", mainzCampusId), q.eq("person.isArchived", false))),
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
  `dynamicGroupUpdateFinished`) and the transport envelopes — `GET` returns
  a single-element `[RuleSet]` array, `PUT` expects a `{ dynamicGroupRuleSet
  }` wrapper — are unwrapped/dropped before comparison.

Both the desired side (your config) and the actual side (fetched from
ChurchTools) are run through the same `normalizeRuleset`
(`src/engine/dynamic.ts`) before diffing. That means: declare a ruleset,
`ct apply` it, then `ct plan` again — no drift, only real content changes
produce a diff. Normalization is scoped to the `query` subtree only; it's
never applied to ruleset-level string fields like `description`/`shorty`, so
a numeric-looking label (e.g. a `description` of `"2024"`) is never silently
retyped to a number and corrupted on write-back.

## Managed guard: undeclared groups stay invisible

Dynamic-group state is only ever fetched for a group that is **both**: (a)
already under state management, and (b) opted in via a `dynamic` block in
the *current* config (`dynamicField.fold` in `src/engine/synthetic.ts`). A
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
