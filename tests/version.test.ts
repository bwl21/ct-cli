import { describe, it, expect } from "vitest";
import { compareVersions, meetsMinVersion } from "../src/api/version.js";

describe("compareVersions", () => {
  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("3.123.0", "3.96.0")).toBeGreaterThan(0);
    expect(compareVersions("3.96.0", "3.123.0")).toBeLessThan(0);
    expect(compareVersions("3.96.0", "3.96.0")).toBe(0);
  });

  it("handles differing segment counts", () => {
    expect(compareVersions("3.96", "3.96.0")).toBe(0);
    expect(compareVersions("4", "3.999.999")).toBeGreaterThan(0);
  });
});

describe("meetsMinVersion", () => {
  it("accepts the live instance version and rejects old ones", () => {
    expect(meetsMinVersion("3.123.0")).toBe(true);
    expect(meetsMinVersion("3.95.9")).toBe(false);
  });
});
