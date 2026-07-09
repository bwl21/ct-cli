import { describe, it, expect } from "vitest";
import { resolveWithEnv } from "../src/util/resolve.js";

describe("resolveWithEnv", () => {
  it("prefers the explicit value, trimmed", () => {
    expect(resolveWithEnv("  ./x.ts  ", "env.ts", "default.ts")).toBe("./x.ts");
  });

  it("falls back to the env value when explicit is missing or blank", () => {
    expect(resolveWithEnv(undefined, "env.ts", "default.ts")).toBe("env.ts");
    expect(resolveWithEnv("   ", "env.ts", "default.ts")).toBe("env.ts");
  });

  it("falls back to the default when both explicit and env are blank/absent", () => {
    expect(resolveWithEnv(undefined, undefined, "default.ts")).toBe("default.ts");
    expect(resolveWithEnv("", "  ", "default.ts")).toBe("default.ts");
  });
});
