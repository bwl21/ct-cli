import { describe, it, expect } from "vitest";
import { resolveAuthId, loadCatalog } from "../src/permissions/catalog.js";

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
    expect(() => resolveAuthId("churchgroup:no such right")).toThrow(/unknown permission "churchgroup:no such right"/i);
  });
  it("loads the whole catalog (187 rights)", () => {
    expect(Object.keys(loadCatalog()).length).toBeGreaterThanOrEqual(180);
  });
});
