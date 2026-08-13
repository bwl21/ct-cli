import { describe, it, expect } from "vitest";
import { computePlan } from "../src/engine/plan.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { State, ManagedResource } from "../src/state/state.js";

const HOST = "https://mychurch.church.tools";

function desired(
  key: string,
  fields: Record<string, unknown>,
  opts: Partial<DesiredResource> = {},
): DesiredResource {
  return { type: "campus", key, fields, dependsOn: [], ...opts };
}

function managed(key: string, id: number, fields: Record<string, unknown>): ManagedResource {
  return { type: "campus", id, key, fields, adoptedAt: "t", updatedAt: "t" };
}

function managedT(type: string, key: string, id: number, fields: Record<string, unknown>): ManagedResource {
  return { type, id, key, fields, adoptedAt: "t", updatedAt: "t" };
}

function stateOf(...entries: ManagedResource[]): State {
  return { version: 1, host: HOST, resources: Object.fromEntries(entries.map((e) => [e.key, e])) };
}

/** actual is keyed by logical key. */
function actualOf(entries: Record<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(entries));
}

describe("computePlan", () => {
  it("plans a create for a config resource absent from state", () => {
    const plan = computePlan([desired("mainz", { name: "Mainz" })], stateOf(), new Map());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ action: "create", key: "mainz", id: null });
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: undefined, to: "Mainz", source: "config" },
    ]);
  });

  it("is a no-op when desired matches actual (id 0 handled)", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 0, { name: "Mainz" })),
      actualOf({ mainz: { name: "Mainz" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "no-op", key: "mainz", id: 0 });
  });

  it("does not collide two resources of different types that share a CT id", () => {
    // campus 'mainz' #0 and group-type 'lead' #0 — a numeric-id map would overwrite one with the other.
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" }), desired("lead", { name: "Lead" }, { type: "group-type" })],
      stateOf(managed("mainz", 0, { name: "Mainz" }), managedT("group-type", "lead", 0, { name: "Lead" })),
      actualOf({ mainz: { name: "Mainz" }, lead: { name: "Lead" } }),
    );
    const byKey = Object.fromEntries(plan.items.map((i) => [i.key, i]));
    expect(byKey.mainz?.action).toBe("no-op");
    expect(byKey.lead?.action).toBe("no-op");
  });

  it("throws when a config key collides with a different type in state", () => {
    expect(() =>
      computePlan(
        [desired("x", { name: "A" }, { type: "campus" })],
        stateOf(managedT("group", "x", 1, { name: "A" })),
        actualOf({ x: { name: "A" } }),
      ),
    ).toThrow(/campus.*group|group.*campus/i);
  });

  it("throws for a desired resource whose type has no apply tier", () => {
    expect(() =>
      computePlan([desired("x", { name: "A" }, { type: "made-up" })], stateOf(), new Map()),
    ).toThrow(/Unknown resource type/);
  });

  it("throws on duplicate desired keys instead of silently last-wins (#35 item 7)", () => {
    // A raw array from a programmatic caller (import command, test harness) could carry duplicates —
    // desiredByKey would collapse them while the plan loop emits both. Reject up front.
    expect(() =>
      computePlan([desired("dup", { name: "A" }), desired("dup", { name: "B" })], stateOf(), new Map()),
    ).toThrow(/Duplicate desired key "dup"/);
  });

  it("plans an update with just the changed fields", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz HQ", shortName: "MZ" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      actualOf({ mainz: { name: "Mainz", shortName: "MZ" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "update", id: 5 });
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: "Mainz", to: "Mainz HQ", source: "config" },
    ]);
  });

  it("does not flag a mere object-key-order difference as a change", () => {
    const plan = computePlan(
      [desired("mz", { nameTranslated: { en: "M", de: "M" } })],
      stateOf(managed("mz", 1, { nameTranslated: { en: "M", de: "M" } })),
      actualOf({ mz: { nameTranslated: { de: "M", en: "M" } } }), // reversed key order
    );
    expect(plan.items[0]?.action).toBe("no-op");
    expect(plan.items[0]?.changes).toEqual([]);
  });

  it("plans a delete for a managed resource dropped from config", () => {
    const plan = computePlan(
      [],
      stateOf(managed("old", 9, { name: "Old" })),
      actualOf({ old: { name: "Old" } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "delete", key: "old", id: 9 });
  });

  it("surfaces a dropped resource already gone from ChurchTools as stale, not a silent no-op", () => {
    const plan = computePlan([], stateOf(managed("old", 9, { name: "Old" })), new Map());
    expect(plan.items[0]).toMatchObject({ action: "no-op", key: "old", id: 9, note: "stale" });
  });

  it("reports drift when ChurchTools differs from the last-known snapshot", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz", shortName: "MZ" })),
      actualOf({ mainz: { name: "Mainz", shortName: "CHANGED" } }),
    );
    expect(plan.items[0]?.drift).toEqual([{ field: "shortName", from: "MZ", to: "CHANGED" }]);
  });

  it("recreates a managed resource that has vanished from ChurchTools", () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      new Map(), // actual absent → 404
    );
    expect(plan.items[0]).toMatchObject({ action: "create", note: "recreate" });
  });

  it("leaves an unresolved-type managed resource untouched instead of recreating it", () => {
    const plan = computePlan(
      [desired("ag", { name: "A" }, { type: "age-group" })],
      stateOf(managedT("age-group", "ag", 3, { name: "A" })),
      new Map(), // could not fetch: type has no registry entry
      { unresolved: new Set(["ag"]) },
    );
    expect(plan.items[0]).toMatchObject({ action: "no-op", note: "unresolved-type" });
  });

  it("never surfaces unmanaged resources", () => {
    // actual contains a key that is neither in config nor state — must be ignored.
    const plan = computePlan([], stateOf(), actualOf({ ghost: { name: "Unmanaged" } }));
    expect(plan.items).toHaveLength(0);
  });

  it("orders create items by dependency (parent before child)", () => {
    const plan = computePlan(
      [
        desired("child", { name: "C" }, { type: "group", parent: "parent", dependsOn: ["parent"] }),
        desired("parent", { name: "P" }, { type: "group" }),
      ],
      stateOf(),
      new Map(),
    );
    expect(plan.items.map((i) => i.key)).toEqual(["parent", "child"]);
  });

  it("orders deletes in reverse tier order (higher tier first)", () => {
    const plan = computePlan(
      [],
      stateOf(managedT("campus", "c", 1, {}), managedT("group", "g", 2, {})),
      actualOf({ c: {}, g: {} }),
    );
    expect(plan.items.map((i) => i.key)).toEqual(["g", "c"]);
  });
});

// Per-field attribution (#24): a JSON consumer needs to tell "this diff exists because the
// config changed" apart from "this diff exists because someone edited ChurchTools manually"
// apart from "both happened, independently". Computed from the SAME three values already
// available (last-known state snapshot, desired config, fetched actual) — no new fetch.
describe("changes[].source attribution (#24)", () => {
  it('tags a plain config change as "config" (ChurchTools still matches the last-known snapshot)', () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz HQ" })],
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      actualOf({ mainz: { name: "Mainz" } }), // actual == last-known → no drift on this field
    );
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: "Mainz", to: "Mainz HQ", source: "config" },
    ]);
  });

  it('tags a pure manual edit as "drift" (config unchanged, ChurchTools moved)', () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })], // config still says the last-known value
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      actualOf({ mainz: { name: "Changed In CT" } }), // manually edited since adoption
    );
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: "Changed In CT", to: "Mainz", source: "drift" },
    ]);
    expect(plan.items[0]?.drift).toEqual([{ field: "name", from: "Mainz", to: "Changed In CT" }]);
  });

  it('tags "config+drift" when both the config AND ChurchTools moved independently', () => {
    const plan = computePlan(
      [desired("mainz", { name: "New Config Name" })],
      stateOf(managed("mainz", 5, { name: "Old Name" })),
      actualOf({ mainz: { name: "Manually Changed Name" } }),
    );
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: "Manually Changed Name", to: "New Config Name", source: "config+drift" },
    ]);
  });

  it('always tags a create\'s changes as "config" (nothing to drift from yet)', () => {
    const plan = computePlan([desired("mainz", { name: "Mainz" })], stateOf(), new Map());
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: undefined, to: "Mainz", source: "config" },
    ]);
  });

  it('always tags a recreate\'s changes as "config"', () => {
    const plan = computePlan(
      [desired("mainz", { name: "Mainz" })],
      stateOf(managed("mainz", 5, { name: "Mainz" })),
      new Map(), // vanished from ChurchTools → recreate
    );
    expect(plan.items[0]).toMatchObject({ action: "create", note: "recreate" });
    expect(plan.items[0]?.changes).toEqual([
      { field: "name", from: undefined, to: "Mainz", source: "config" },
    ]);
  });

  it("does not phantom-attribute a newly-managed field absent from the state snapshot as drift", () => {
    // Pre-existing precedent (see the "group campus assignment" describe block below): a field the
    // state snapshot never tracked must not read as "drift" just because it differs from actual.
    const plan = computePlan(
      [desired("team", { name: "Team", campusId: 7 }, { type: "group" })],
      stateOf(managedT("group", "team", 9, { name: "Team" })), // no campusId in the snapshot
      actualOf({ team: { name: "Team", campusId: 4 } }),
    );
    expect(plan.items[0]?.changes).toEqual([{ field: "campusId", from: 4, to: 7, source: "config" }]);
    expect(plan.items[0]?.drift).toBeUndefined();
  });
});

// A group's campus (`information.campusId`, managed as top-level `campusId`) is a plain diffed
// field — assign, change, and clear are all ordinary updates. The actual side is normalised to a
// concrete `null` when unset (see registry), so each transition diffs against a real value.
describe("group campus assignment (#21)", () => {
  const g = (key: string, fields: Record<string, unknown>): DesiredResource =>
    desired(key, fields, { type: "group" });
  const gState = (fields: Record<string, unknown>): State =>
    stateOf(managedT("group", "team", 9, { name: "Team", groupTypeId: 2, groupStatusId: 1, ...fields }));

  it("assigns a campus to a previously unassigned group", () => {
    const plan = computePlan(
      [g("team", { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 })],
      gState({ campusId: null }),
      actualOf({ team: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: null } }),
    );
    expect(plan.items[0]).toMatchObject({ action: "update", key: "team" });
    expect(plan.items[0]?.changes).toEqual([{ field: "campusId", from: null, to: 4, source: "config" }]);
  });

  it("plans a campus move as a normal field update", () => {
    const plan = computePlan(
      [g("team", { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 7 })],
      gState({ campusId: 4 }),
      actualOf({ team: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 } }),
    );
    expect(plan.items[0]?.changes).toEqual([{ field: "campusId", from: 4, to: 7, source: "config" }]);
  });

  it("clears a campus assignment (campusId: null)", () => {
    const plan = computePlan(
      [g("team", { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: null })],
      gState({ campusId: 4 }),
      actualOf({ team: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 } }),
    );
    expect(plan.items[0]?.changes).toEqual([{ field: "campusId", from: 4, to: null, source: "config" }]);
  });

  it("is a no-op when desired campus matches actual", () => {
    const plan = computePlan(
      [g("team", { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 })],
      gState({ campusId: 4 }),
      actualOf({ team: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 } }),
    );
    expect(plan.items[0]?.action).toBe("no-op");
  });

  it("does not drift on a pre-#21 state snapshot that lacks campusId (config omits it too)", () => {
    // A group adopted before campusId was managed: its state snapshot has no campusId key, and the
    // pre-#21 config declares none either. The fetched actual now carries campusId (managed). This
    // must stay a no-op — no phantom drift, no spurious update — proving no state migration is needed.
    const plan = computePlan(
      [g("team", { name: "Team", groupTypeId: 2, groupStatusId: 1 })],
      stateOf(managedT("group", "team", 9, { name: "Team", groupTypeId: 2, groupStatusId: 1 })),
      actualOf({ team: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 } }),
    );
    expect(plan.items[0]?.action).toBe("no-op");
    expect(plan.items[0]?.changes).toEqual([]);
  });
});

describe("allowDuplicateName threading onto create items (#75)", () => {
  it("carries the flag onto a fresh create item", () => {
    const plan = computePlan(
      [{ type: "group", key: "kids_b", fields: { name: "Kids" }, dependsOn: [], allowDuplicateName: true }],
      stateOf(),
      new Map(),
    );
    expect(plan.items[0]).toMatchObject({ action: "create", allowDuplicateName: true });
  });

  it("carries the flag onto a recreate create item (managed but vanished from ChurchTools)", () => {
    const plan = computePlan(
      [{ type: "group", key: "kids_b", fields: { name: "Kids" }, dependsOn: [], allowDuplicateName: true }],
      stateOf(managedT("group", "kids_b", 9, { name: "Kids" })),
      new Map(), // vanished: no actual entry
    );
    expect(plan.items[0]).toMatchObject({ action: "create", note: "recreate", allowDuplicateName: true });
  });

  it("is undefined on a create item when not declared", () => {
    const plan = computePlan([desired("mainz", { name: "Mainz" })], stateOf(), new Map());
    expect(plan.items[0]?.allowDuplicateName).toBeUndefined();
  });
});
