# Dynamic-group ruleset/status fixtures

Captured **read-only** on 2026-07-08 from the production instance
`eqrm.church.tools` (CT 3.134.0), which has 68 real dynamic groups. No writes
were made to produce these; they are `GET` responses saved verbatim.

## Files

- `ruleset.get.json` — canonical fixture (copy of `ruleset-683.get.json`).
- `ruleset-683.get.json` — group #683: string **and** object `dterm` labels, nested `or`/`and`/`!`, `oneof` over string-id arrays, `isnull`, the `"true and"` operator.
- `ruleset-2022.get.json` — group #2022: `isnull`, `subgroups` (with `levelfrom`/`levelto`), `person.campusId`, `groupmember.groupMemberStatus == "active"`, mixed int/string ids.
- `ruleset-1092.get.json` — group #1092: doubly-nested `and`, two `oneof role.id` branches.
- `status.get.json` — `{ "dynamicGroupStatus": "active" }` (the shape `GET …/status` returns).

## Shape notes (source of truth for the normalizer)

- **`GET /dynamicgroups/{id}/ruleset` returns a single-element ARRAY `[RuleSet]`** — NOT the bare object the OpenAPI schema advertises. The normalizer must unwrap the array (take element 0).
- **`RuleSet`** = `{ description, shorty, personIdFieldName, importance, query, process }`.
- **`query`** is a ChurchQuery envelope: `{ method: "ChurchQuery", params: { groupBy, filter, primaryEntityAlias, responseFields } }`. The JSONLogic tree is in `params.filter`.
- **`dterm: [label, expr]`** wraps a subtree with a **cosmetic** label. `label` is either a plain string (`"Nur aktive Personen"`) or an object (`{ title, stereotype? }`, where `title` may be an i18n key like `group.automatic-membership.default-archived.title`). The label is never evaluated → strip it, keep `expr`.
- **int/string inconsistency is pervasive:** the same logical value appears as both `1` and `"1"`; `oneof` id arrays are sometimes `[1]` and sometimes `["112","8"]`. The normalizer coerces numeric strings to numbers before diffing.
- **operators seen:** `and`, `or`, `!`, `==`, `oneof`, `isnull`, `isnotnull`, `subgroups`, `"true and"`.
- **`process`** = `{ groupOnly, queryResultOnly, groupAndQueryResult }` (any may be `{}`). Each maps a member status (`active` | `to_delete` | `none` | …) → `{ handleMembership: { groupMemberStatus, groupTypeRoleId? } }`.

## Round-trip (write) tests

The write-side round-trip test (plan Task 6) is gated behind `CT_LIVE=1` and a
`CT_DYNAMIC_FIXTURE_GID` and must target a **dev** instance — **never run it
against this production login.**

## Pinned assumptions / how to run the gated round-trip (#36)

`tests/dynamic.integration.test.ts` has three live-gated tests across two
`describe` blocks, all skipped by default (`npm test` never runs them):

1. **`CT_LIVE=1`** — read → normalize → write-back-of-CT's-own-GET is a no-op,
   and the committed fixture still matches the instance. Read-mostly; the
   write-back re-sends exactly what CT returned, so it is drift-free by
   construction.
2. **`CT_LIVE=1 CT_LIVE_WRITE=1 CT_LIVE_WRITE_HOST=<dev host>
CT_DYNAMIC_FIXTURE_GID=<disposable dev group id>`** — the **#36 pin**:
   PUTs a ruleset this test authors itself (custom `description`, `shorty`,
   `importance`, …, never copied from a GET) to the designated group, GETs it
   back, and asserts normalized deep-equality field by field. It also builds
   a plan from the same user-authored desired ruleset and asserts the
   `dynamic` field diffs to no-op — the property #36 actually protects (a
   no-op plan requires `deepEqual(desired.dynamic, actual.dynamic)`). The
   group's prior ruleset is captured before the PUT and restored in a
   `finally`.

**What this pins:** that CT does not silently rewrite/normalize a
RuleSet-level field (`description`, `shorty`, `importance`,
`personIdFieldName`, `process`) on `PUT` — `normalizeRuleset`
(`src/engine/dynamic.ts`) only strips the two read-only timestamp keys and
normalizes the `query` subtree; it currently assumes every other RuleSet-level
field round-trips byte-for-byte.

**If it fails:** the failure message names exactly which RuleSet-level
field(s) CT rewrote and shows authored-vs-returned values. Extend
`normalizeRuleset` to canonicalize/drop those fields the same way it already
handles `query` — do not weaken the test.

**Precondition:** `CT_DYNAMIC_FIXTURE_GID` must point at a **disposable**
dynamic group on a **dev** instance whose ruleset may be freely overwritten.
The test restores the group's prior ruleset afterward, but a process kill or
crash mid-run would leave it holding the test-authored ruleset — never point
this at a group anyone depends on, and never at the production login.
