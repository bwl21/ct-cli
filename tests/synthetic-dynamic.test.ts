import { describe, it, expect, vi } from "vitest";
import { SYNTHETIC_FIELDS, syntheticField } from "../src/engine/synthetic.js";
import { normalizeDynamic } from "../src/engine/dynamic.js";
import { CtApiError } from "../src/api/ctClient.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { CtClient } from "../src/api/ctClient.js";

const dynamicField = () => syntheticField("dynamic")!;

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
