# ChurchTools API Coverage — Structure-as-Code CLI (Phase 0 Spike)

Analysis of the ChurchTools OpenAPI spec (`openapi.json`, OpenAPI 3.1.0, 487 paths).

## ChurchTools version

- The spec's own `info.version` is **`0.1.0`** — that is the _API-doc_ version, **not** the CT release.
- The real CT version is exposed by the **`GET /info`** endpoint, whose response schema documents:
  - `version` = "ChurchTools Version", **example `3.123.0`**
  - `build` = "Database Build Version", example `31843`
- **`3.123.0` >> `3.96`**, so the Notion design's requirement that group-hierarchy / metadata CRUD needs **CT v3.96+** is comfortably met on this installation. (The `/info` endpoint is also live, so the CLI can assert the minimum version at runtime.)
- Note: the ChurchTools API doc is self-trimming — `info.description` states it "will always show only those endpoints you can use with your ChurchTools installation." So the presence of the write endpoints below is itself evidence they exist on this version.

## Coverage matrix

Methods marked only if they actually exist on the matched path. "Update" = PUT or PATCH (noted). Collection paths (list/create) vs item paths (`/{id}`) are separated.

| #   | Resource               | Matched path(s)                                                                                                                                                                                | GET (list / by-id)                     | POST (create)                               | PUT/PATCH (update)      | DELETE              | Verdict                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------- | ----------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ct_campus`            | `/campuses`, `/campuses/{id}`                                                                                                                                                                  | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 2   | `ct_group_type`        | `/group/grouptypes`, `/group/grouptypes/{groupTypeId}`                                                                                                                                         | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 3   | `ct_group`             | `/groups`, `/groups/{groupId}`                                                                                                                                                                 | list ✅ / by-id ✅                     | ✅                                          | ✅ PATCH                | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 4   | `ct_group_hierarchy`   | `/groups/hierarchies` (GET), `/groups/{groupId}/children` (GET), `/groups/{groupId}/parents` (GET), `/groups/{groupId}/parents/{parentGroupId}` (PUT/DELETE)                                   | list ✅ (hierarchies/children/parents) | — (no collection POST)                      | ✅ PUT links a parent   | ✅ unlinks a parent | **Writable** — parent/child edges created & removed via PUT/DELETE on the item path (no POST needed)                                                                                                                                                                                                                                                           |
| 5   | `ct_group_role`        | `/group/roles`, `/group/roles/{roleId}`                                                                                                                                                        | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD** (master-data roles). Per-group assignment lives separately at `/groups/{groupId}/roles` GET + `/groups/{groupId}/roles/{roleId}` PATCH.                                                                                                                                                                                                          |
| 6   | `ct_dynamic_group`     | `/dynamicgroups` (GET), `/dynamicgroups/{groupId}/ruleset` (GET/PUT/DELETE), `/dynamicgroups/{groupId}/status` (GET/PUT), `/dynamicgroups/refresh` & `/dynamicgroups/{groupId}/refresh` (POST) | list ✅ / ruleset & status by-id ✅    | ⚠️ POST only triggers _refresh_, not create | ✅ PUT ruleset & status | ✅ ruleset DELETE   | **Partial** — ruleset is fully updatable/deletable; the group entity itself is created via `/groups` (POST) then given a ruleset. No dedicated create/delete of the dynamic-group record.                                                                                                                                                                      |
| 7   | `ct_permission`        | `/permissions/global` (GET), `/permissions/{domainType}` (GET), `/permissions/{domainType}/{domainId}` (GET/PUT/DELETE); `/permissions/internal/...` (GET)                                     | list ✅ / by-id ✅                     | — (no collection POST)                      | ✅ PUT sets permission  | ✅                  | **Writable** — assign/revoke via PUT/DELETE on `/{domainType}/{domainId}`                                                                                                                                                                                                                                                                                      |
| 8   | `ct_group_status`      | `/group/memberstatus` (GET only) — see note                                                                                                                                                    | list ✅ / —                            | ❌                                          | ❌                      | ❌                  | **Read-only → manual for now.** No group-status write endpoint. (`/statuses` + `/statuses/{id}` DO offer full CRUD, but that is the person/community **Status** master data, tag `Status`, not group status — do not conflate.)                                                                                                                                |
| 9   | `ct_age_group`         | `/group/agegroups`, `/group/agegroups/{ageGroupId}`                                                                                                                                            | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 10  | `ct_target_group`      | `/group/targetgroups`, `/group/targetgroups/{targetGroupId}`                                                                                                                                   | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |
| 11  | `ct_meeting_point`     | — none —                                                                                                                                                                                       | ❌                                     | ❌                                          | ❌                      | ❌                  | **Not in API → fully manual.** Zero matches for `treffpunkt`/`meetingpoint`/`meeting point` anywhere in the spec. Closest neighbours are _meeting templates_ (`/group/meetingtemplates`, full CRUD) and _group meetings_ (`/groups/{groupId}/meetings`, CRUD) — different concepts; confirm with product whether "meeting point" was meant to be one of those. |
| 12  | `ct_relationship_type` | `/person/relationshiptypes`, `/person/relationshiptypes/{id}`                                                                                                                                  | list ✅ / by-id ✅                     | ✅                                          | ✅ PUT                  | ✅                  | **Full CRUD**                                                                                                                                                                                                                                                                                                                                                  |

## MVP recommendation

### Fully writable now (ship CRUD in the MVP) — 7 resources

Standard collection-POST + item-GET/PUT(-or-PATCH)/DELETE shape, safe to drive from the CLI:

- `ct_campus`
- `ct_group_type`
- `ct_group` (update is PATCH, not PUT)
- `ct_group_role`
- `ct_age_group`
- `ct_target_group`
- `ct_relationship_type`

### Writable via non-standard verbs (support, but special-case the client) — 2 resources

No collection POST; state is set/removed through PUT/DELETE on the item path. Model these as "declare desired edge/assignment, reconcile via PUT/DELETE":

- `ct_group_hierarchy` — manage parent links via `PUT`/`DELETE /groups/{groupId}/parents/{parentGroupId}`
- `ct_permission` — assign/revoke via `PUT`/`DELETE /permissions/{domainType}/{domainId}`

### Partial — 1 resource

- `ct_dynamic_group` — ruleset & status are updatable (`PUT`) and ruleset deletable (`DELETE`), but the group record is created through `/groups`. Treat as: create shell group via `ct_group`, then manage its ruleset. No first-class create/delete of the dynamic-group entity.

### Read-only / not in API → keep manual for now — 2 resources

- `ct_group_status` — only `GET /group/memberstatus` exists (read-only). No write endpoint. (Do not substitute `/statuses`, which is person-status master data.)
- `ct_meeting_point` — **no endpoint at all**; cannot be automated until CT ships one (or until "meeting point" is redefined onto meeting-templates/meetings, both of which are full CRUD).

### Version gate

The installation reports **CT `3.123.0`** via `/info`, so every write endpoint above is available and the v3.96+ hierarchy/metadata requirement is satisfied. Recommend the CLI call `GET /info` on startup and hard-fail below `3.96.0`.
