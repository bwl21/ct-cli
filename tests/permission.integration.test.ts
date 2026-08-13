/**
 * Gated, opt-in live round-trip for the permissions engine (Task 7).
 *
 * Read-only block (CT_LIVE=1): read a `group_type_role`'s current grants from
 * a live instance, reconstruct a config that declares exactly those
 * user-authored grants, and assert `buildPermissionPlan` diffs to a no-op
 * (empty toPut/toDelete) — i.e. read → diff is drift-free. This block issues
 * GET requests only; it never PUTs or DELETEs.
 *
 * Write block (CT_LIVE=1 AND CT_LIVE_WRITE=1, plus an explicit host-match
 * guard): PUTs and DELETEs a single throwaway grant to check apply
 * idempotency. Doubly gated so it can never fire against production by
 * accident — it does not run in this repo's default CI or dev-machine state.
 */
import { describe, it, expect } from "vitest";
import { authedSession } from "../src/api/session.js";
import { buildPermissionPlan } from "../src/permissions/plan.js";
import { applyPermissionPlan } from "../src/permissions/apply.js";
import { normalizeActual, type RawPermission } from "../src/permissions/grants.js";
import { CATALOG } from "../src/permissions/catalog.js";
import type { State, ManagedResource } from "../src/state/state.js";
import type { DesiredPermission, Grant } from "../src/permissions/types.js";

const live = process.env.CT_LIVE === "1";
const liveWrite = process.env.CT_LIVE_WRITE === "1";
const DOMAIN_ID = Number(process.env.CT_PERM_FIXTURE_ID ?? "0"); // a disposable group_type_role domainId

/** authId → catalog name, for reversing actual grants back into declarable rights. */
function reverseCatalog(): Map<number, string> {
  const byAuthId = new Map<number, string>();
  for (const [name, entry] of Object.entries(CATALOG)) {
    if (!byAuthId.has(entry.authId)) byAuthId.set(entry.authId, name);
  }
  return byAuthId;
}

/** Build a synthetic State that maps every scoped group dataId to its own logical key. */
function stateForDataIds(dataIds: number[]): State {
  const resources: Record<string, ManagedResource> = {};
  for (const id of dataIds) {
    const key = `fixture_group_${id}`;
    resources[key] = { type: "group", id, key, fields: {}, adoptedAt: "t", updatedAt: "t" };
  }
  return { version: 1, host: "dev-fixture", resources };
}

describe.runIf(live)("permission round-trip (live, read-only)", () => {
  it("read → diff against the domain's current grants is a no-op (drift-free)", async () => {
    const { client } = await authedSession();

    const all = await client.get<RawPermission[]>("/permissions/group_type_role");
    const rows = all.filter((r) => r.domainId === DOMAIN_ID);
    const actual = normalizeActual(rows);

    const nameByAuthId = reverseCatalog();
    const allDataIds = [...new Set(actual.flatMap((t) => t.dataId))];
    const state = stateForDataIds(allDataIds);

    const grants: Grant[] = actual.map((t) => {
      const name = nameByAuthId.get(t.authId);
      if (!name) throw new Error(`No catalog entry for authId ${t.authId} — cannot round-trip this grant.`);
      if (t.dataId.length === 0) return name;
      return { right: name, scope: t.dataId.map((id) => `fixture_group_${id}`) };
    });

    const desired: DesiredPermission = {
      key: "fixture",
      domainType: "group_type_role",
      domainId: DOMAIN_ID,
      grants,
    };

    // Read-only: buildPermissionPlan only issues GETs.
    const { items, fetchErrors } = await buildPermissionPlan(client, state, [desired]);

    expect(fetchErrors).toEqual([]);
    expect(items[0]?.diff.toPut).toEqual([]);
    expect(items[0]?.diff.toDelete).toEqual([]);
  });
});

// Doubly gated: requires CT_LIVE=1 (outer describe.runIf) AND CT_LIVE_WRITE=1
// AND an explicit host-match confirmation, so this can never fire against the
// dev machine's current (production) login. It does not run here.
describe.runIf(live && liveWrite)("permission round-trip (live, write) — apply idempotency", () => {
  it("PUT then DELETE a throwaway grant, twice, is idempotent", async () => {
    const { client } = await authedSession();

    const expectedHost = process.env.CT_LIVE_WRITE_HOST?.trim();
    if (!expectedHost || client.host !== expectedHost) {
      throw new Error(
        "CT_LIVE_WRITE requires CT_LIVE_WRITE_HOST to be set and to exactly match the authenticated " +
          "host, as a non-production confirmation guard. Refusing to write.",
      );
    }

    const throwaway: DesiredPermission = {
      key: "fixture-write",
      domainType: "group_type_role",
      domainId: DOMAIN_ID,
      grants: [], // operator must fill in a single disposable right before enabling CT_LIVE_WRITE
    };
    const state: State = { version: 1, host: expectedHost, resources: {} };

    const before = await buildPermissionPlan(client, state, [throwaway]);
    await applyPermissionPlan(before.items, client);
    const after = await buildPermissionPlan(client, state, [throwaway]);
    expect(after.items[0]?.diff.toPut).toEqual([]);
    expect(after.items[0]?.diff.toDelete).toEqual([]);

    // clean up: re-diff and re-apply should still be a no-op (idempotent apply)
    await applyPermissionPlan(after.items, client);
    const again = await buildPermissionPlan(client, state, [throwaway]);
    expect(again.items[0]?.diff.toPut).toEqual([]);
    expect(again.items[0]?.diff.toDelete).toEqual([]);
  });
});
