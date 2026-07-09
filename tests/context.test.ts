import { describe, it, expect } from "vitest";
import { createContext, evaluateConfig, type ConfigContext } from "../src/config/context.js";
import { isKnownType } from "../src/engine/graph.js";
import { RESOURCES } from "../src/resources/registry.js";

describe("config context", () => {
  it("builds desired resources from DSL calls, separating key/parent from fields", () => {
    const { ct, resources } = createContext();
    ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
    ct.group({ key: "kids", name: "Kids", parent: "mainz", groupTypeId: 3 });

    expect(resources[0]).toEqual({
      type: "campus",
      key: "mainz",
      fields: { name: "Mainz", shortName: "MZ" },
      parent: undefined,
      dependsOn: [],
    });
    expect(resources[1]).toMatchObject({
      type: "group",
      key: "kids",
      fields: { name: "Kids", groupTypeId: 3 },
      parent: "mainz",
      dependsOn: ["mainz"],
    });
  });

  it("merges explicit dependsOn with the parent edge", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "Team", parent: "lead", dependsOn: ["type_x"] });
    expect(resources[0]?.dependsOn).toEqual(["type_x", "lead"]);
  });

  it("captures multiple parents (hierarchy is a DAG) as an opt-in set, not in fields", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "Team", parents: ["area_a", "area_b"] });
    expect(resources[0]?.parents).toEqual(["area_a", "area_b"]);
    expect(resources[0]?.dependsOn).toEqual(["area_a", "area_b"]);
    expect(resources[0]?.fields).not.toHaveProperty("parents");
  });

  it("treats parents as opt-in: omitted → undefined, explicit [] → managed-empty", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "no_hierarchy", name: "N" });
    ct.group({ key: "empty_hierarchy", name: "E", parents: [] });
    expect(resources[0]?.parents).toBeUndefined();
    expect(resources[1]?.parents).toEqual([]);
  });

  it("de-duplicates the `parents` set", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "T", parents: ["lead", "other", "lead"] });
    expect(resources[0]?.parents).toEqual(["lead", "other"]);
  });

  it("keeps `parent` out of managed hierarchy: it is an ordering edge only, never in `parents`", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "T", parent: "lead", parents: ["other"] });
    expect(resources[0]?.parent).toBe("lead");
    expect(resources[0]?.parents).toEqual(["other"]); // `lead` is NOT folded into managed parents
    expect(resources[0]?.dependsOn).toEqual(["lead", "other"]); // both still contribute ordering edges
  });

  it("treats a falsy `parent` as absent, not as opt-in to managed-empty hierarchy", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "g", name: "G", parent: "" });
    expect(resources[0]?.parents).toBeUndefined(); // no hierarchy management
    expect(resources[0]?.dependsOn).toEqual([]);
  });

  it("passes a numeric campusId through as a plain field (the #21 escape hatch)", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "team", name: "Team", groupTypeId: 2, campusId: 4 });
    expect(resources[0]?.fields).toEqual({ name: "Team", groupTypeId: 2, campusId: 4 });
    // null is allowed (clears the assignment).
    const { ct: ct2, resources: r2 } = createContext();
    ct2.group({ key: "team", name: "Team", campusId: null });
    expect(r2[0]?.fields).toEqual({ name: "Team", campusId: null });
  });

  it("sugars a logical `campus`/`groupType`/`status` into a Ref-valued id field (#20)", () => {
    const { ct, resources } = createContext();
    ct.group({ key: "g", name: "G", campus: "mainz", groupType: "ministry_team", status: "active" });
    expect(resources[0]?.fields).toEqual({
      name: "G",
      campusId: { __ctRef: true, kind: "campus", key: "mainz" },
      groupTypeId: { __ctRef: true, kind: "group-type", key: "ministry_team" },
      groupStatusId: { __ctRef: true, kind: "group-status", key: "active" },
    });
  });

  it("rejects declaring both the logical and the numeric id form", () => {
    const { ct } = createContext();
    expect(() => ct.group({ key: "g", name: "G", campus: "mainz", campusId: 4 })).toThrow(
      /either "campus".*or "campusId".*not both/,
    );
  });

  it("rejects a non-string logical reference and a non-numeric/non-ref id field", () => {
    const { ct } = createContext();
    expect(() => ct.group({ key: "g", name: "G", campus: 4 as never })).toThrow(/non-empty string key/);
    expect(() => ct.group({ key: "h", name: "H", campusId: "4" as never })).toThrow(/must be a number/);
  });

  it("rejects a non-array / non-string `parents`", () => {
    const { ct } = createContext();
    expect(() => ct.group({ key: "g", name: "G", parents: "area" as never })).toThrow(/array of string/);
    expect(() => ct.group({ key: "h", name: "H", parents: [1] as never })).toThrow(/array of string/);
  });

  it("rejects a hierarchy parent that is not a declared group", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.campus({ key: "mz", name: "Mainz" });
        ct.group({ key: "kids", name: "Kids", parents: ["mz"] }); // mz is a campus
      }),
    ).rejects.toThrow(/is a campus, not a group/);

    await expect(
      evaluateConfig((ct) => {
        ct.group({ key: "kids", name: "Kids", parents: ["ghost"] }); // never declared
      }),
    ).rejects.toThrow(/not declared in this config/);
  });

  it("rejects a duplicate logical key", () => {
    const { ct } = createContext();
    ct.campus({ key: "mainz", name: "A" });
    expect(() => ct.campus({ key: "mainz", name: "B" })).toThrow(/Duplicate/);
  });

  it("rejects a missing key", () => {
    const { ct } = createContext();
    expect(() => ct.campus({ name: "no key" } as never)).toThrow(/key/);
  });

  it("every DSL resource type has an apply tier (context and graph stay in sync)", () => {
    const { ct, resources } = createContext();
    ct.campus({ key: "a", name: "a" });
    ct.group({ key: "b", name: "b" });
    ct.groupType({ key: "c", name: "c" });
    ct.ageGroup({ key: "d", name: "d" });
    ct.targetGroup({ key: "e", name: "e" });
    ct.relationshipType({ key: "f", name: "f" });
    ct.roleDefinition({ key: "g", name: "g", groupTypeId: 2 });
    for (const r of resources) {
      expect(isKnownType(r.type), `type "${r.type}" is missing from TYPE_TIER`).toBe(true);
    }
  });

  it("every registry type has a matching ConfigContext resource method (registry ↔ context sync, #35 item 6)", () => {
    // ConfigContext isn't derived from the registry, so lock the two in sync: each registry entry's
    // DSL name (its `dslName`, else the camelCase of the type) must be a callable ct method — a
    // renamed/added type without its DSL surface fails here instead of at config-load time.
    const { ct } = createContext();
    const camel = (t: string): string => t.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    for (const [type, spec] of Object.entries(RESOURCES)) {
      const fn = spec.dslName ?? camel(type);
      expect(typeof (ct as unknown as Record<string, unknown>)[fn], `registry type "${type}" expects ct.${fn}()`).toBe(
        "function",
      );
    }
  });

  it("declares the master-data group role as a plannable group-role resource (not the permission surface)", () => {
    const { ct, resources, permissions } = createContext();
    ct.roleDefinition({ key: "leiter", name: "Leiter", groupTypeId: 2 });
    expect(permissions).toEqual([]); // roleDefinition is a resource, never a permission grant
    expect(resources).toEqual([
      expect.objectContaining({ type: "group-role", key: "leiter", fields: { name: "Leiter", groupTypeId: 2 } }),
    ]);
    expect(isKnownType(resources[0]!.type)).toBe(true); // has an apply tier → plannable
  });

  it("evaluateConfig runs a module against a fresh context (blueprints + loops)", async () => {
    const { resources } = await evaluateConfig((ct) => {
      for (const c of ["mainz", "berlin"]) {
        ct.campus({ key: c, name: c });
        ct.group({ key: `${c}_kids`, name: `${c} kids`, parent: c });
      }
    });
    expect(resources.map((r) => r.key)).toEqual(["mainz", "mainz_kids", "berlin", "berlin_kids"]);
  });
});

describe("dynamic block", () => {
  it("attaches a validated dynamic spec to the group and drops it from plain fields", async () => {
    const { ct, resources } = createContext();
    ct.group({
      key: "all_mainz",
      name: "Alle Mainz",
      groupTypeId: 1,
      dynamic: { status: "manual", ruleset: { description: "x", method: "ChurchQuery", params: {} } },
    });
    const g = resources.find((r) => r.key === "all_mainz")!;
    expect(g.dynamic).toEqual({ status: "manual", ruleset: { description: "x", method: "ChurchQuery", params: {} } });
    expect(g.fields).not.toHaveProperty("dynamic"); // never a plain diffed field
  });

  it("rejects an invalid status", async () => {
    const { ct } = createContext();
    expect(() => ct.group({ key: "g", name: "G", dynamic: { status: "bogus", ruleset: {} } as never })).toThrow(
      /dynamic.*status/i,
    );
  });

  it("rejects dynamic on a non-group", async () => {
    const { ct } = createContext();
    expect(() =>
      ct.campus({ key: "c", name: "C", dynamic: { status: "manual", ruleset: {} } } as never),
    ).toThrow(/dynamic.*only.*group/i);
  });

  it("rejects a null dynamic block with a clean error", async () => {
    const { ct } = createContext();
    expect(() => ct.group({ key: "g", name: "G", dynamic: null } as never))
      .toThrow(/dynamic/i);
  });
});

describe("preventDestroy lifecycle flag", () => {
  it("is carried on the resource but kept out of managed fields", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.group({ key: "kids_lead", name: "Kids Leitung", preventDestroy: true });
    });
    const group = resources.find((r) => r.key === "kids_lead")!;
    expect(group.preventDestroy).toBe(true);
    expect(group.fields).toEqual({ name: "Kids Leitung" });
  });

  it("defaults to undefined when not declared", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
    });
    expect(resources[0]!.preventDestroy).toBeUndefined();
  });
});

describe("permission declarations", () => {
  it("collects groupRole / groupTypeRole with validated grants", async () => {
    const mod = (ct: ConfigContext) => {
      ct.groupTypeRole({ key: "leiter_tpl", id: 8, grants: [
        "churchgroup:view group",
        { right: "churchdb:view group", scope: ["kids_area"] },
      ]});
      ct.groupRole({ key: "kids_lead", id: 2882, grants: ["churchgroup:edit group members"] });
    };
    const { permissions } = await evaluateConfig(mod); // evaluateConfig now returns {resources, permissions}
    expect(permissions).toHaveLength(2);
    expect(permissions[0]).toMatchObject({ key: "leiter_tpl", domainType: "group_type_role", domainId: 8 });
    expect(permissions[1]).toMatchObject({ key: "kids_lead", domainType: "group_role", domainId: 2882 });
  });
  it("rejects a non-numeric id and an empty right name", async () => {
    await expect(
      evaluateConfig((ct: ConfigContext) => ct.groupRole({ key: "x", id: "nope", grants: [] } as never)),
    ).rejects.toThrow(/numeric "id"/i);
    await expect(
      evaluateConfig((ct: ConfigContext) => ct.groupRole({ key: "x", id: 1, grants: [""] })),
    ).rejects.toThrow(/grant/i);
  });

  it("rejects a non-finite id (NaN)", async () => {
    await expect(
      evaluateConfig((ct: ConfigContext) => ct.groupRole({ key: "x", id: NaN, grants: [] })),
    ).rejects.toThrow(/numeric "id"/i);
  });

  it("rejects two declarations targeting the same (domainType, domainId)", async () => {
    await expect(
      evaluateConfig((ct: ConfigContext) => {
        ct.groupTypeRole({ key: "leiter_tpl", id: 8, grants: ["churchgroup:view group"] });
        ct.groupTypeRole({ key: "x", id: 8, grants: ["churchdb:view group members"] });
      }),
    ).rejects.toThrow(/Duplicate permission target.*group_type_role #8.*"leiter_tpl".*"x"/s);
  });

  it("allows the same domainId across different domainTypes (no false-positive dedup)", async () => {
    const { permissions } = await evaluateConfig((ct: ConfigContext) => {
      ct.groupTypeRole({ key: "a", id: 8, grants: ["churchgroup:view group"] });
      ct.groupRole({ key: "b", id: 8, grants: ["churchgroup:view group"] });
    });
    expect(permissions).toHaveLength(2);
  });

  it("sugars a logical `groupType` into a Ref-valued domainId (#20)", async () => {
    const { permissions } = await evaluateConfig((ct: ConfigContext) =>
      ct.groupTypeRole({ key: "tpl", groupType: "ministry_team", grants: ["churchgroup:view group"] }),
    );
    expect(permissions[0]?.domainId).toEqual({ __ctRef: true, kind: "group-type", key: "ministry_team" });
  });

  it("sugars group_role `group` + `role` into a compound Ref (gated at plan time, #25)", async () => {
    const { permissions } = await evaluateConfig((ct: ConfigContext) =>
      ct.groupRole({ key: "p", group: "kids", role: "Leiter", grants: ["churchgroup:view group"] }),
    );
    expect(permissions[0]?.domainId).toEqual({ __ctRef: true, kind: "group-role", group: "kids", role: "Leiter" });
  });

  it("rejects declaring both a numeric id and a logical domain form", async () => {
    await expect(
      evaluateConfig((ct: ConfigContext) =>
        ct.groupTypeRole({ key: "tpl", id: 8, groupType: "mt", grants: ["churchgroup:view group"] }),
      ),
    ).rejects.toThrow(/either "id".*or "groupType".*not both/);
  });

  it("dedups two logical declarations targeting the same group-type ref", async () => {
    await expect(
      evaluateConfig((ct: ConfigContext) => {
        ct.groupTypeRole({ key: "a", groupType: "mt", grants: ["churchgroup:view group"] });
        ct.groupTypeRole({ key: "b", groupType: "mt", grants: ["churchdb:view group members"] });
      }),
    ).rejects.toThrow(/Duplicate permission target.*group-type:mt/s);
  });
});
