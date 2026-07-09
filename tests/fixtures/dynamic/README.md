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
