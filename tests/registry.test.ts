import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { slug, resourceType, configSnippet, knownFields, RESOURCES } from "../src/resources/registry.js";
import { loadConfig } from "../src/config/load.js";

describe("slug", () => {
  it("normalises names to underscore keys", () => {
    expect(slug("Kids Leitung")).toBe("kids_leitung");
    expect(slug("Kids 0–3")).toBe("kids_0_3");
    expect(slug("  MZ  ")).toBe("mz");
  });

  it("strips German diacritics to their base letters instead of adding underscores", () => {
    expect(slug("Zürich")).toBe("zurich");
    expect(slug("Jugendküche")).toBe("jugendkuche");
    expect(slug("Gebärdensprache")).toBe("gebardensprache");
  });
});

describe("resourceType", () => {
  it("returns the campus spec with the right item path", () => {
    expect(resourceType("campus").itemPath(0)).toBe("/campuses/0");
  });

  it("builds the group-type item path from its collection path", () => {
    expect(resourceType("group-type").itemPath(7)).toBe("/group/grouptypes/7");
  });

  it("throws for an unknown type, listing the known ones", () => {
    expect(() => resourceType("nope")).toThrow(/Adoptable types/);
  });

  it("derives a key from campus shorty", () => {
    expect(RESOURCES.campus?.deriveKey({ name: "Mainz", shorty: "MZ" })).toBe("mz");
  });

  it("snapshots group ids whether they are nested under information or top-level", () => {
    expect(
      RESOURCES.group?.managedFields({
        name: "Team",
        information: { groupTypeId: 2, groupStatusId: 1, campusId: 4 },
      }),
    ).toEqual({ name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 });
    expect(
      RESOURCES.group?.managedFields({ name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: 4 }),
    ).toEqual({
      name: "Team",
      groupTypeId: 2,
      groupStatusId: 1,
      campusId: 4,
    });
  });

  it("normalises an unset group campus to null (never undefined) and preserves campus id 0", () => {
    // No campus anywhere → null, so the actual side is a concrete value that assign/clear can diff against.
    // (groupStatusId, un-normalised, stays undefined here — toEqual ignores it; only campusId is coalesced.)
    expect(RESOURCES.group?.managedFields({ name: "Team", information: { groupTypeId: 2 } })).toEqual({
      name: "Team",
      groupTypeId: 2,
      campusId: null,
    });
    // Mainz is campus id 0 — must survive the null-coalescing, not collapse to null.
    expect(
      RESOURCES.group?.managedFields({ name: "Team", information: { groupTypeId: 2, campusId: 0 } })
        ?.campusId,
    ).toBe(0);
  });
});

describe("configSnippet — idiomatic multi-line output (#52 item A)", () => {
  it("renders a prettier-compatible multi-line call with the logical key first", () => {
    expect(configSnippet("campus", "mainz", { name: "Mainz", shortName: "MZ" })).toBe(
      ["campus({", '  key: "mainz",', '  name: "Mainz",', '  shortName: "MZ",', "});"].join("\n"),
    );
  });

  it("camelCases a hyphenated type into the function name", () => {
    expect(configSnippet("group-type", "commitment", { name: "Commitment" })).toBe(
      ["groupType({", '  key: "commitment",', '  name: "Commitment",', "});"].join("\n"),
    );
  });

  it("omits undefined fields", () => {
    expect(configSnippet("group", "team", { name: "Team", groupTypeId: undefined })).toBe(
      ["group({", '  key: "team",', '  name: "Team",', "});"].join("\n"),
    );
  });

  it("emits the master-data role under roleDefinition, not the colliding permission name groupRole", () => {
    expect(configSnippet("group-role", "leiter", { name: "Leiter", groupTypeId: 2 })).toBe(
      ["roleDefinition({", '  key: "leiter",', '  name: "Leiter",', "  groupTypeId: 2,", "});"].join("\n"),
    );
  });

  it("flags a field named in `todos` with a trailing `// TODO: no logical match` comment", () => {
    expect(
      configSnippet("group", "team", { name: "Team", groupTypeId: 5 }, { todos: new Set(["groupTypeId"]) }),
    ).toBe(
      [
        "group({",
        '  key: "team",',
        '  name: "Team",',
        "  groupTypeId: 5, // TODO: no logical match",
        "});",
      ].join("\n"),
    );
  });

  it("collapses a `dynamic` block to `true` when it matches the ./rulesets/<key>.json convention", () => {
    expect(
      configSnippet("group", "all_mainz", {
        name: "Alle",
        dynamic: { status: "active", ruleset: { ref: "./rulesets/all_mainz.json" } },
      }),
    ).toContain("  dynamic: true,");
  });

  it("collapses a `dynamic` block to the bare path string when active but off-convention", () => {
    expect(
      configSnippet("group", "g", {
        name: "G",
        dynamic: { status: "active", ruleset: { ref: "./custom/rules.json" } },
      }),
    ).toContain('  dynamic: "./custom/rules.json",');
  });

  it("keeps a non-active `dynamic` block as an explicit object", () => {
    const snip = configSnippet("group", "g", {
      name: "G",
      dynamic: { status: "manual", ruleset: { ref: "./rulesets/g.json" } },
    });
    expect(snip).toContain("  dynamic: {");
    expect(snip).toContain('    status: "manual",');
  });
});

// Round-trip guarantee: whatever `adopt` prints for any adoptable type must be declarable.
// Wrapping every registry type's snippet in a config and loading it through the real loader
// pins the adopt→config contract so a DSL-name collision (issue #31) can't regress silently.
describe("configSnippet round-trips through the config loader for every adoptable type", () => {
  it.each(Object.keys(RESOURCES))("%s", async (type) => {
    const key = `adopted_${type.replace(/-/g, "_")}`;
    const snippet = configSnippet(type, key, { name: "Round Trip" });
    const dir = mkdtempSync(join(tmpdir(), "ct-adopt-"));
    writeFileSync(join(dir, "ct.config.ts"), `export default (ct) => { ct.${snippet} };`);

    const { resources } = await loadConfig(join(dir, "ct.config.ts"));
    const loaded = resources.find((r) => r.key === key);
    expect(loaded, `snippet for "${type}" did not load: ${snippet}`).toBeDefined();
    expect(loaded?.type).toBe(type);
  });
});

describe("write specs", () => {
  it("campus creates via POST /campuses and updates via PUT", () => {
    expect(RESOURCES.campus?.collectionPath).toBe("/campuses");
    expect(RESOURCES.campus?.updateMethod).toBe("PUT");
  });

  it("group updates via PATCH", () => {
    expect(RESOURCES.group?.collectionPath).toBe("/groups");
    expect(RESOURCES.group?.updateMethod).toBe("PATCH");
  });

  it("registers the new writable types with their collection + item paths", () => {
    expect(RESOURCES["age-group"]?.collectionPath).toBe("/group/agegroups");
    expect(RESOURCES["target-group"]?.collectionPath).toBe("/group/targetgroups");
    expect(RESOURCES["relationship-type"]?.collectionPath).toBe("/person/relationshiptypes");
    expect(RESOURCES["group-role"]?.collectionPath).toBe("/group/roles");
    expect(RESOURCES["age-group"]?.itemPath(3)).toBe("/group/agegroups/3");
  });

  // Field sets verified live against eqrm.church.tools (2026-07-08).
  it("snapshots real relationship-type degree fields (degreeNameA/B, not degreeForward/Reverse)", () => {
    const raw = {
      name: "relationship.couple",
      nameTranslated: "Couple",
      degreeNameA: "spouse",
      degreeNameB: "spouse",
      securityLevelId: 1,
    };
    expect(RESOURCES["relationship-type"]?.managedFields(raw)).toEqual({
      name: "relationship.couple",
      nameTranslated: "Couple",
      degreeNameA: "spouse",
      degreeNameB: "spouse",
    });
  });

  it("snapshots age-group / group-role fields that exist on the live payload", () => {
    expect(
      RESOURCES["age-group"]?.managedFields({ name: "NextGen", nameTranslated: "NextGen", sortKey: 8 }),
    ).toEqual({ name: "NextGen", nameTranslated: "NextGen", sortKey: 8 });
    expect(
      RESOURCES["group-role"]?.managedFields({
        name: "Mitglied",
        nameTranslated: "Mitglied",
        groupTypeId: 2,
      }),
    ).toEqual({ name: "Mitglied", nameTranslated: "Mitglied", groupTypeId: 2 });
  });
});

describe("createDefaults — required-but-unmanaged create fields (#73)", () => {
  it("group-type fills every field CT requires at POST, derived from the declared name", () => {
    expect(RESOURCES["group-type"]?.createDefaults?.({ name: "Dienst", nameTranslated: "Dienst" })).toEqual({
      namePlural: "Dienst",
      shorty: "Dienst",
      color: "default",
      permissionDepth: 1,
      isLeaderNecessary: false,
      availableForNewPerson: false,
      sortKey: 0,
      postsEnabled: false,
    });
  });

  it("group-type truncates namePlural to 30 and shorty to 10 chars", () => {
    const name = "Superlange Kleingruppen Bezeichnung"; // 35 chars
    const defaults = RESOURCES["group-type"]?.createDefaults?.({ name });
    expect(defaults?.namePlural).toBe(name.slice(0, 30));
    expect((defaults?.namePlural as string).length).toBe(30);
    expect(defaults?.shorty).toBe("Superlange");
    expect((defaults?.shorty as string).length).toBe(10);
  });

  it("group-type keeps a short name intact (no padding, no truncation)", () => {
    const defaults = RESOURCES["group-type"]?.createDefaults?.({ name: "Team" });
    expect(defaults?.namePlural).toBe("Team");
    expect(defaults?.shorty).toBe("Team");
  });

  it("group-role fills the required `shorty` from the declared name (truncated to 10)", () => {
    expect(
      RESOURCES["group-role"]?.createDefaults?.({ name: "Verantwortlicher", groupTypeId: 2 }),
    ).toEqual({ shorty: "Verantwort" });
  });

  it("does not attach create-defaults to types whose managed fields already satisfy the create contract", () => {
    // campus (name+shorty) is verified working live; group/age-group/target-group need only `name`.
    for (const type of ["campus", "group", "age-group", "target-group", "relationship-type"]) {
      expect(RESOURCES[type]?.createDefaults).toBeUndefined();
    }
  });
});

describe("knownFields (#51)", () => {
  it("derives the campus allowlist from managedFields — 'shorty', not the vestigial 'shortName'", () => {
    expect(knownFields("campus")).toEqual(new Set(["name", "shorty"]));
  });

  it("derives the group allowlist, including fields read via fromInformation", () => {
    expect(knownFields("group")).toEqual(new Set(["name", "groupTypeId", "groupStatusId", "campusId"]));
  });

  it("derives an allowlist for every registered resource type without throwing", () => {
    for (const type of Object.keys(RESOURCES)) {
      expect(() => knownFields(type)).not.toThrow();
      expect(knownFields(type).size).toBeGreaterThan(0);
    }
  });

  it("throws the same 'Adoptable types' error as resourceType for an unknown type", () => {
    expect(() => knownFields("widget")).toThrow(/Adoptable types/);
  });
});

describe("configSnippet null omission", () => {
  it("omits null-valued fields — a campus-less group adopts without managing 'no campus'", () => {
    expect(configSnippet("group", "team", { name: "Team", groupTypeId: 2, campusId: null })).toBe(
      ["group({", '  key: "team",', '  name: "Team",', "  groupTypeId: 2,", "});"].join("\n"),
    );
  });
});
