import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYNTHETIC_FIELDS, syntheticField, foldSynthetic } from "../src/engine/synthetic.js";
import { normalizeDynamic, resolveRulesetRef } from "../src/engine/dynamic.js";
import { loadConfig } from "../src/config/load.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const dynamicField = () => syntheticField("dynamic")!;
const getClient = (client: unknown) => client as unknown as Pick<CtClient, "get">;

describe("dynamic synthetic field — fold", () => {
  it("injects normalized dynamic into desired.fields and actual for an opted-in managed group", async () => {
    expect(SYNTHETIC_FIELDS.some((f) => f.field === "dynamic")).toBe(true);
    const state: State = { version: 1, host: "h",
      resources: { g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" } } };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      { type: "group", key: "g", fields: { name: "G" }, dependsOn: [],
        dynamic: { status: "manual", ruleset: { description: "x", query: {}, process: {} } } },
    ];
    const client = { get: vi.fn(async (p: string) =>
      p.endsWith("/ruleset") ? { description: "x", query: {}, process: {}, dynamicGroupUpdateStarted: "t" }
                             : { dynamicGroupStatus: "manual" }) };
    const out = await dynamicField().fold({ client: client as unknown as Pick<CtClient, "get">, state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("g")?.dynamic).toEqual({ status: "manual", ruleset: { description: "x", query: {}, process: {} } });
    expect(out.desired[0]?.fields.dynamic).toEqual({ status: "manual", ruleset: { description: "x", query: {}, process: {} } });
  });

  it("tolerates a 404 on the ruleset fetch — group is not (yet) a dynamic group", async () => {
    const state: State = { version: 1, host: "h",
      resources: { g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" } } };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      { type: "group", key: "g", fields: { name: "G" }, dependsOn: [],
        dynamic: { status: "active", ruleset: { description: "x", query: {}, process: {} } } },
    ];
    const client = { get: vi.fn(async () => { throw new CtApiError("Not Found", 404, null); }) };
    const out = await dynamicField().fold({ client: client as unknown as Pick<CtClient, "get">, state, desired, actual });
    expect(out.errors).toEqual([]);
    expect(actual.get("g")?.dynamic).toEqual({ status: "none", ruleset: {} });
  });

  it("demote-to-none is a no-op against the 404 sentinel", () => {
    expect(normalizeDynamic({ status: "none", ruleset: {} })).toEqual({ status: "none", ruleset: {} });
  });

  it("propagates a status-GET failure as an error rather than fabricating the 'none' sentinel", async () => {
    // FIX 5: the ruleset GET succeeded, so this group HAS a real ruleset. A subsequent status-GET
    // failure must NOT be swallowed into { status: "none", ruleset: {} } (which would discard the
    // ruleset and propose a spurious re-PUT) — it degrades the plan via `errors`.
    const state: State = { version: 1, host: "h",
      resources: { g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" } } };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [
      { type: "group", key: "g", fields: { name: "G" }, dependsOn: [],
        dynamic: { status: "active", ruleset: { description: "x", query: {}, process: {} } } },
    ];
    const client = { get: vi.fn(async (p: string) => {
      if (p.endsWith("/ruleset")) return { description: "x", query: {}, process: {} };
      throw new CtApiError("Server Error", 500, null); // status GET fails AFTER a good ruleset GET
    }) };
    const out = await dynamicField().fold({ client: getClient(client), state, desired, actual });
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/dynamic g status \(#5\)/);
    expect(actual.get("g")).not.toHaveProperty("dynamic"); // NOT clobbered with the sentinel
  });

  it("ignores groups that did not opt into dynamic", async () => {
    const state: State = { version: 1, host: "h",
      resources: { g: { type: "group", id: 5, key: "g", fields: { name: "G" }, adoptedAt: "t", updatedAt: "t" } } };
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const desired: DesiredResource[] = [{ type: "group", key: "g", fields: { name: "G" }, dependsOn: [] }];
    const client = { get: vi.fn() };
    await dynamicField().fold({ client: client as unknown as Pick<CtClient, "get">, state, desired, actual });
    expect(client.get).not.toHaveBeenCalled();
    expect(actual.get("g")).not.toHaveProperty("dynamic");
  });
});

describe("dynamic synthetic field — apply", () => {
  it("PUTs the wrapped ruleset then the status", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({ client: { request } as unknown as Pick<CtClient, "request">, state, id: 5,
      change: { field: "dynamic", from: undefined,
        to: { status: "active", ruleset: { description: "x", query: {}, process: {} } } } });
    expect(request).toHaveBeenNthCalledWith(1, "PUT", "/dynamicgroups/5/ruleset",
      { dynamicGroupRuleSet: { description: "x", query: {}, process: {} } });
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", { dynamicGroupStatus: "active" });
  });

  it("demotes to a normal group when status is none: DELETE ruleset then status none", async () => {
    const request = vi.fn(async () => ({}));
    const state: State = { version: 1, host: "h", resources: {} };
    await dynamicField().apply({ client: { request } as unknown as Pick<CtClient, "request">, state, id: 5,
      change: { field: "dynamic", from: { status: "active", ruleset: {} }, to: { status: "none", ruleset: {} } } });
    expect(request).toHaveBeenNthCalledWith(1, "DELETE", "/dynamicgroups/5/ruleset");
    expect(request).toHaveBeenNthCalledWith(2, "PUT", "/dynamicgroups/5/status", { dynamicGroupStatus: "none" });
  });
});

describe("resolveRulesetRef", () => {
  it("resolves { ref } relative to the given baseDir (config dir), not the process cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    writeFileSync(join(dir, "rs.json"), JSON.stringify({ description: "from-file", query: {}, process: {} }));
    expect(resolveRulesetRef({ ref: "./rs.json" }, dir)).toEqual({ description: "from-file", query: {}, process: {} });
  });

  it("passes an inline ruleset through unchanged", () => {
    expect(resolveRulesetRef({ description: "inline" }, "/nowhere")).toEqual({ description: "inline" });
  });

  it("throws a clear error naming the group and resolved path when the ref file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    expect(() => resolveRulesetRef({ ref: "./missing.json" }, dir, "all_mainz"))
      .toThrow(/group "all_mainz".*cannot read.*missing\.json/is);
  });

  it("throws a clear error when the ref file is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-ref-"));
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(() => resolveRulesetRef({ ref: "./bad.json" }, dir, "g")).toThrow(/not valid JSON/i);
  });
});

describe("dynamic { ref } ruleset — resolved relative to the config file", () => {
  const mkConfig = (rulesetLiteral: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ct-cfg-"));
    writeFileSync(
      join(dir, "ct.config.ts"),
      `export default (ct) => { ct.group({ key: "g", name: "G", groupTypeId: 1, ` +
        `dynamic: { status: "manual", ruleset: ${rulesetLiteral} } }); };`,
    );
    return dir;
  };
  const state: State = { version: 1, host: "h",
    resources: { g: { type: "group", id: 5, key: "g", fields: {}, adoptedAt: "t", updatedAt: "t" } } };
  const foldClient = () => ({ get: vi.fn(async (p: string) =>
    p.endsWith("/ruleset") ? { description: "actual", query: {}, process: {} } : { dynamicGroupStatus: "manual" }) });

  it("threads the config dir so { ref } resolves against the config file, not the cwd", async () => {
    const dir = mkConfig(`{ ref: "./rules.json" }`);
    writeFileSync(join(dir, "rules.json"), JSON.stringify({ description: "from-ref", importance: 0, query: {}, process: {} }));
    const { resources, configDir } = await loadConfig(join(dir, "ct.config.ts"));
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    const out = await foldSynthetic({ client: getClient(foldClient()), state, desired: resources, actual, configDir });
    expect(out.desired.find((d) => d.key === "g")?.fields.dynamic)
      .toMatchObject({ status: "manual", ruleset: { description: "from-ref" } });
  });

  it("surfaces a clear error (group + path) when the { ref } file is missing", async () => {
    const dir = mkConfig(`{ ref: "./missing.json" }`);
    const { resources, configDir } = await loadConfig(join(dir, "ct.config.ts"));
    const actual = new Map<string, Record<string, unknown>>([["g", { name: "G" }]]);
    await expect(foldSynthetic({ client: getClient(foldClient()), state, desired: resources, actual, configDir }))
      .rejects.toThrow(/group "g".*cannot read.*missing\.json/is);
  });
});
