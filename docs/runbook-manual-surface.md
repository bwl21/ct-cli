# Runbook: manual ChurchTools surface

What `ct` **cannot** (yet, or ever) manage, so instance bootstrap (#23) can
apply "selective adoption" deliberately instead of guessing. If reproducing an
instance from code means "rebuild the scaffold with `ct apply`, then do
_these_ specific clicks by hand," this is the list of those clicks.

Every item below falls into exactly one of three buckets:

- **API gap** — ChurchTools does not expose a write endpoint (or any
  endpoint) for this. Nothing in `ct` can close this until CT ships one.
- **Not yet implemented** — the ChurchTools API supports it, but `ct` doesn't
  drive it yet. Tracked by an open issue; closing the issue removes the item
  from this runbook.
- **Out of tool scope** — deliberately, permanently unmanaged. Not a gap to
  close; a boundary the tool is designed to respect.

## API gap — CT does not expose a write endpoint

| Item                           | What it is                                                                                           | Why manual                                                                                                                                                                                 | Where in the CT admin UI                                                   | How to verify                                                                                                                                                                                                                                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group member-statuses          | The set of "member status" values a group can assign to its members (e.g. active/candidate)          | Only `GET /group/memberstatus` exists; no create/update/delete endpoint ([`docs/api-coverage.md`](api-coverage.md) #8)                                                                     | Group settings → member status admin (org-wide master data, not per-group) | `ct get raw /group/memberstatus` (no dedicated `ct get member-statuses` subcommand yet — the generic `raw` path covers it) and diff by eye against the expected list below                                                                                                                      |
| Meeting points (Treffpunkte)   | A group's meeting-location master data                                                               | No endpoint at all — zero matches for `treffpunkt`/`meetingpoint` anywhere in the OpenAPI spec ([`docs/api-coverage.md`](api-coverage.md) #11)                                             | Group admin → meeting point field on a group                               | No API verification possible; visually confirm in the UI. (Do not confuse with _meeting templates_ `/group/meetingtemplates` or _group meetings_ `/groups/{id}/meetings`, both full CRUD but different concepts — confirm with product if "meeting point" was meant to be one of those instead) |
| Permission name↔authId catalog | The mapping from human-readable `module:right` names to the numeric `authId` the API actually writes | Not exposed by the REST API at all; only servable via the legacy `POST /index.php?q=churchauth/ajax&func=getMasterData` call ([`src/permissions/README.md`](../src/permissions/README.md)) | Permission editor (any role's right-picker enumerates the live set)        | Regeneration procedure below (**Permission catalog lifecycle**)                                                                                                                                                                                                                                 |

**Expected values for our instance(s):** left blank here deliberately — this
runbook is generic (part of `ct-cli`, the tool repo). The per-instance
expected/desired values (which member statuses, which meeting points) belong
in `eqrm/ct-structure`'s own runbook once #23 creates that repo, following
this doc's structure.

## Not yet implemented — API supports it, `ct` doesn't drive it yet

| Item                                  | What it is                                                                                                                                                                                                    | Tracking issue                                                          | Manual workaround today                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Group ↔ campus assignment (same-run)  | Assigning a group to a campus **created in the same `ct apply`** — needs the new campus's id at eval time, which is unknowable without the logical-reference resolver. Assignment to an **existing** campus by numeric `campusId` **is managed now** (#21)      | [#20](https://github.com/eqrm/ct-cli/issues/20)                         | Apply the campus first, look up its id (`ct get campuses`), then set `campusId: <id>` on the group and apply again; or assign by hand in the CT admin page. `plan` diffs the numeric `campusId` as a normal field update  |
| Group/group-type field decision table | Fields deliberately left unmanaged (decided out of scope): visibility, note, `autoAccept`/open-for-members, chat status, sort key. The triage **shipped** as a committed decision table ([`docs/group-field-decisions.md`](group-field-decisions.md))          | [#21](https://github.com/eqrm/ct-cli/issues/21) (decided)               | Set by hand; these fields are intentionally not diffed — `ct` will neither preserve nor revert them. Promote one later only with its own registry entry + tests                                                           |
| Portable/logical references           | Config still hardcodes numeric CT ids (`groupTypeId`, `groupStatusId`, `campusId`, permission `domainId`, dynamic-group ruleset `var` values like `q.eq("ctgroup.campusId", 4)`) instead of resolving keys/names per host | [#20](https://github.com/eqrm/ct-cli/issues/20)                         | Hand-resolve each id per target host (`ct get group-types`, `ct get campuses`, etc.) and hardcode it in config; a config authored against one instance will not plan correctly against another until this lands           |
| Environments (dev → prod promotion)   | Named `(host, token, state file)` profiles and a `--env` flag; today one config + one state file = one host                                                                                                   | [#22](https://github.com/eqrm/ct-cli/issues/22)                         | Point `CT_HOST`/state file manually at each target and re-run; keep dev and prod state files apart yourself, and be careful — nothing stops you from applying a dev-shaped config against prod today                      |
| Permission `domainId` by reference    | `ct.groupRole`/`ct.groupTypeRole` require the numeric `domainId` supplied by hand — for `group_role` this is CT's internal (group, role) _pairing_ id, with **no CLI lookup helper**                          | [#25](https://github.com/eqrm/ct-cli/issues/25)                         | Find the pairing id via the CT permission editor, or an existing `GET /permissions/group_role` response for a group+role you already have, and hardcode it ([`docs/permissions.md`](permissions.md) "domainId semantics") |
| Grant adoption                        | No `ct adopt grants <domain>` — existing rights structures on a live instance must be hand-transcribed into `grants: [...]` config blocks                                                                     | [#25](https://github.com/eqrm/ct-cli/issues/25)                         | `ct get raw /permissions/group_role/<id>` (or `group_type_role`), read off the non-inherited, non-baseline rows (`isInherited: false`, `meta.modifiedPid !== -1`), and hand-author the equivalent `grants:` array         |
| Permission catalog lifecycle          | `catalog.json` is a one-off HAR-trace snapshot of a single CT version, with no staleness detection                                                                                                            | [#25](https://github.com/eqrm/ct-cli/issues/25)                         | Manual regeneration procedure below (**Permission catalog lifecycle**)                                                                                                                                                    |
| API re-audit for new CT releases      | CT's OpenAPI spec is self-trimming (only shows endpoints your version has), so a new write endpoint (e.g. a group-status write) appears silently between CT upgrades                                          | tracked by this issue ([#26](https://github.com/eqrm/ct-cli/issues/26)) | Procedure below (**Re-audit procedure for new CT releases**)                                                                                                                                                              |

## Out of tool scope — deliberate, not a gap

| Item                                                                                                                                | Why it's out of scope                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| People, memberships, group member lists                                                                                             | Hard boundary enforced in code (`assertNotPeople`, `src/engine/guard.ts`) — the tool manages rights-bearing _structure_ only, never who's in it. This is permanent by design, not a roadmap item; see README's "People are never managed"                                                                                                 |
| Other CT modules — calendars, services (`churchservice`), resource booking (`churchresource`), forms, check-in, wiki, finance, sync | Never in the tool's stated mandate ("campuses, structural groups, hierarchies, group types/roles, permission & auto-groups" — README). Phase 0's coverage matrix (`docs/api-coverage.md`) only analyzed the 12 resource types relevant to that structural mandate; nothing else was assessed for CRUD support and nothing else is planned |
| Module-level settings, custom fields, i18n                                                                                          | Out of tool scope by design — global instance configuration, not per-resource declarative structure                                                                                                                                                                                                                                       |

## Permission catalog lifecycle (regeneration procedure)

Until #25's scripted lifecycle lands, regenerate `src/permissions/catalog.json`
by hand when the instance's CT version changes materially:

1. Open the ChurchTools permission editor in a browser with devtools
   recording (Network tab).
2. Trigger the request: `POST /index.php?q=churchauth/ajax` with body
   `func=getMasterData`.
3. Export the HAR and extract `log.entries[].response` for that request.
4. Flatten `data.auth_table[module][right]` to
   `"module:right" → { authId: id, scopeField: datenfeld, revocable: !!isRevocable, desc: bezeichnung }`.
5. Overwrite `src/permissions/catalog.json` and update the "Captured
   <date> from ... (CT <version>)" note in `src/permissions/README.md`.

`ct plan`/`ct apply` throw a clear "did you mean" error for an unknown right
name today; there is no version-mismatch warning yet (tracked under #25).

## Re-audit procedure for new CT releases

CT's OpenAPI spec (`GET $CT_HOST/system/runtime/swagger/openapi.json`, pulled
by `npm run generate:client`) is **self-trimming**: `info.description` states
it "will always show only those endpoints you can use with your ChurchTools
installation." That means a version bump can silently add a write endpoint
this runbook still lists as an API gap (most plausibly: a `group/memberstatus`
write endpoint, or a meeting-point endpoint).

Until a scripted diff exists, re-audit manually after any CT upgrade:

1. Re-fetch the spec: `npm run generate:client` (writes
   `src/api/schema.d.ts`) or fetch `openapi.json` directly and open it.
2. For each item in the **API gap** table above, re-check whether its path
   now has additional methods (grep the spec for `/group/memberstatus`,
   `treffpunkt`/`meetingpoint`, etc.).
3. If a write method appeared: promote the item — add it to
   `src/resources/registry.ts` (or the relevant synthetic field), extend
   the DSL, add tests, and delete its row from this runbook's API-gap table.
4. Re-run `GET /info` to confirm the CT `version`/`build` this audit was
   performed against, and note it in the commit that updates this file.

This mirrors (and should eventually replace by scripting) the Phase 0 spike
that produced `docs/api-coverage.md` — see that doc for the full method.

## Checklist for a new instance

Order matches `ct apply`'s own dependency tiers (campuses/master-data before
groups before hierarchy/dynamic/permissions), with the manual items slotted
in where they'd otherwise be silently skipped:

1. `ct apply` the structural config (campuses, group types, age/target
   groups, groups, hierarchy, dynamic groups, permission grants).
2. **Group ↔ campus assignment** — declare `campusId: <existing campus id>`
   on the group in config; `ct` diffs and applies it like any field (#21).
   Only assignment to a campus created in the *same* apply is still manual
   (#20) — apply the campus first, then set its numeric id.
3. **Member statuses** — confirm the expected set exists via
   `ct get raw /group/memberstatus`; create any missing ones by hand in the
   CT admin UI.
4. **Meeting points** — set by hand per group where applicable; no API
   verification.
5. **Permission catalog** — confirm `src/permissions/catalog.json` was
   captured against a CT version ≥ this instance's `GET /info` version; if
   it's stale, regenerate first (**Permission catalog lifecycle** above)
   before trusting `ct plan`'s permission diff.
6. **Grants not yet expressed as config** — for any domain object with
   hand-set rights not covered by a `ct.groupRole`/`ct.groupTypeRole`
   declaration, transcribe them into config now (adoption workaround above)
   so they don't silently diverge from what `ct plan` believes is desired.
7. **Anything from the "out of tool scope" table** — persons, memberships,
   calendars, services, resource booking, forms, check-in, wiki, finance,
   sync, module-level settings, custom fields, i18n — configure per your
   organization's own (non-`ct`) process; this tool will never surface or
   touch these.
8. Run `ct plan` once more: it should be a clean no-op. Anything it still
   proposes is a real drift, not a manual-surface item.

## Open uncertainty

- The exact expected/desired **values** (which member statuses, which
  meeting points, which campus-per-group assignments) are instance-specific
  and deliberately not enumerated here — they belong in `eqrm/ct-structure`
  once #23 creates that repo. This runbook only tracks _what category_ of
  manual step exists and _how to verify_ it, not the target values for any
  particular ChurchTools instance.
- "Meeting point" (Treffpunkt) has no confirmed CT concept mapping — `docs/api-coverage.md`
  flags that it might actually mean _meeting templates_ or _group meetings_
  (both full CRUD, i.e. not actually manual at all). Confirm with product
  before treating it as a permanent API gap.
