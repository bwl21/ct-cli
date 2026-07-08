import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { authedSession } from "../src/api/session.js";

const live = process.env.CT_LIVE === "1";
const GID = Number(process.env.CT_DYNAMIC_FIXTURE_GID ?? "0"); // the group id from Task 1

describe.runIf(live)("dynamic round-trip (live)", () => {
  it("read → normalize → write-back is a no-op (drift-free)", async () => {
    const { client } = await authedSession();
    const before = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    const normalized = normalizeRuleset(before);
    await client.request("PUT", `/dynamicgroups/${GID}/ruleset`, { dynamicGroupRuleSet: normalized });
    const after = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    expect(normalizeRuleset(after)).toEqual(normalized); // writing back the normalized form does not drift
  });

  it("the committed fixture matches what the instance still returns", async () => {
    const { client } = await authedSession();
    const raw = JSON.parse(readFileSync("tests/fixtures/dynamic/ruleset.get.json", "utf8"));
    const fixture = raw.data ?? raw;
    const nowRuleset = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);
    expect(normalizeRuleset(nowRuleset)).toEqual(normalizeRuleset(fixture));
  });
});
