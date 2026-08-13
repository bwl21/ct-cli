import { describe, it, expect } from "vitest";
import { resolveAuthId, CATALOG, CATALOG_META, KNOWN_AUTH_IDS } from "../src/permissions/catalog.js";

describe("permission catalog", () => {
  it("resolves a known global right to its authId", () => {
    const e = resolveAuthId("churchgroup:view");
    expect(e.authId).toBe(1101);
    expect(e.scopeField).toBeNull();
  });
  it("resolves a scoped right and exposes its scopeField", () => {
    const e = resolveAuthId("churchgroup:view group");
    expect(e.authId).toBe(1104);
    expect(e.scopeField).toBe("cdb_gruppe");
  });
  it("throws a helpful error for an unknown right", () => {
    expect(() => resolveAuthId("churchgroup:no such right")).toThrow(
      /unknown permission "churchgroup:no such right"/i,
    );
  });
  it("exposes the whole catalog (187 rights)", () => {
    expect(Object.keys(CATALOG).length).toBeGreaterThanOrEqual(180);
  });
  it("does NOT expose the reserved $meta key as a right", () => {
    expect(CATALOG).not.toHaveProperty("$meta");
    expect(resolveAuthId("churchgroup:view")).toBeTruthy(); // sanity: rights still resolve
    expect(() => resolveAuthId("$meta")).toThrow(/unknown permission/i);
  });
  it("records provenance (CT version) for staleness detection (#25)", () => {
    expect(CATALOG_META).not.toBeNull();
    expect(CATALOG_META?.ctVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CATALOG_META?.rightCount).toBe(Object.keys(CATALOG).length);
  });
  it("exposes the set of known authIds (for the unknown-authId plan warning)", () => {
    expect(KNOWN_AUTH_IDS.has(1104)).toBe(true); // churchgroup:view group
    expect(KNOWN_AUTH_IDS.has(999999)).toBe(false);
    expect(KNOWN_AUTH_IDS.size).toBe(new Set(Object.values(CATALOG).map((e) => e.authId)).size);
  });
});
