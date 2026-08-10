# Permission catalog (name ↔ authId bridge)

`catalog.json` is the static map from human-readable `module:right` names to numeric
ChurchTools `authId`s, used to author permission grants as code (issue #13).

## Why static

The name↔authId catalog is **not exposed by the ChurchTools REST API**. It is only
served to the permission-editor UI via the legacy endpoint:

```
POST /index.php?q=churchauth/ajax    body: func=getMasterData
→ { data: { auth_table: { <module>: { <rightName>: { id, auth, modulename, datenfeld, bezeichnung, isRevocable, ... } } } } }
```

Captured 2026-07-08 from `eqrm.church.tools` (CT 3.134.0) via a browser HAR trace of that
request. It is reference data for that CT version; regenerate if the instance's CT version
changes materially.

## Shape

```json
{
  "$meta": { "capturedFrom": "eqrm.church.tools", "ctVersion": "3.134.0", "capturedAt": "2026-07-08", "rightCount": 187 },
  "churchgroup:view group": { "authId": 1104, "scopeField": "cdb_gruppe", "revocable": false, "desc": "View group incl. its group members" },
  "churchcore:administer settings": { "authId": 1, "scopeField": null, "revocable": false, "desc": "Edit system settings" }
}
```

- **`$meta`** (#25) — a reserved top-level provenance key (NOT a right):
  `capturedFrom`, `ctVersion`, `capturedAt`, `rightCount`. `catalog.ts` splits
  it off at load so no consumer (`resolveAuthId`, `ct get permissions-catalog`,
  grant adoption) ever sees it as a right. `ctVersion` drives `ct plan`'s
  staleness warning — see `docs/handbuch/permissions.md` "Catalog lifecycle & staleness".

- **key** — `"<modulename>:<auth>"`, the DSL vocabulary (e.g. `churchgroup:view group`).
- **authId** — numeric id sent in the `PermissionRequest` write body.
- **scopeField** — the ChurchTools data-field a scoped right applies to (`datenfeld`), or `null`
  for an unscoped/global right. A non-null `scopeField` is a right that accepts a `dataId[]` scope.
  Most scoped rights carry `scopeField: "cdb_gruppe"` (a group) — those are the only ones
  declarable via a **logical group key** in the DSL's `scope: [...]`. Any other non-null
  `scopeField` (`cc_securitylevel`, `cdb_comment_viewer`, `cdb_station`, …) names a dimension this
  tool has no managed representation for, so it can only be declared via the **numeric scope
  escape hatch** (`scope: [1, 2, 3]`, #49) — see `docs/handbuch/permissions.md`.
- **revocable** — whether the right supports `type: "revoke"` (`isRevocable` in the source).
- **desc** — human description (`bezeichnung`).

187 rights across 14 modules (churchcore, churchdb, churchgroup, churchcal, churchservice,
churchresource, churchcheckin, churchwiki, churchreport, finance, churchsync, …).

## Regeneration

**One command (#25):**

```bash
CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
```

`scripts/regenerate-permission-catalog.ts` logs in with the login token, calls
`POST /index.php?q=churchauth/ajax` `func=getMasterData`, flattens
`data.auth_table[module][right]` to
`"module:right" → { authId: id, scopeField: datenfeld, revocable: !!isRevocable, desc: bezeichnung }`,
stamps the instance's CT version into `$meta`, and rewrites this file. It only
**reads** from the instance. Review the `git diff` before committing.

**Manual fallback (HAR):** open the permission editor in the CT admin with
devtools recording, export the HAR, extract `log.entries[].response` for the
`churchauth/ajax` `func=getMasterData` POST, and apply the same flattening.
