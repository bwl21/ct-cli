import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { normalizeRuleset } from "../src/engine/dynamic.js";
import { diffFields } from "../src/engine/plan.js";
import { syntheticField } from "../src/engine/synthetic.js";
import { authedSession } from "../src/api/session.js";
import type { State } from "../src/state/state.js";
import type { DesiredResource } from "../src/engine/types.js";
import type { DynamicStatus } from "../src/engine/types.js";

const live = process.env.CT_LIVE === "1";
const liveWrite = process.env.CT_LIVE_WRITE === "1";
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

/**
 * #36 pin: does a USER-AUTHORED ruleset — one this test writes itself, never copied from a prior
 * GET — round-trip byte-for-byte (after normalization) through a PUT/GET cycle?
 *
 * The two tests above write back CT's OWN GET output, so they are drift-free by construction: if
 * CT silently rewrote/normalized a RuleSet-level field (`description`, `shorty`, `importance`,
 * `personIdFieldName`, `process` — see docs/dynamic-groups.md "Drift, normalization, and no-op
 * re-applies") on PUT, those tests could never observe it, because the value they wrote back
 * already matched. This test authors fresh field values instead, so it CAN observe such rewrites.
 * If it fails, the failure message names exactly which RuleSet-level field(s) changed — add those
 * to `normalizeRuleset` (`src/engine/dynamic.ts`) rather than to this test.
 *
 * Doubly gated like the permissions write round-trip (`tests/permission.integration.test.ts`):
 * CT_LIVE=1 AND CT_LIVE_WRITE=1, plus an explicit CT_LIVE_WRITE_HOST host-match guard, so this can
 * never fire against production by accident. It does not run in this repo's default CI or
 * dev-machine state.
 *
 * PRECONDITION: CT_DYNAMIC_FIXTURE_GID must point at a DISPOSABLE dynamic group on a **dev**
 * instance — one whose ruleset this test may freely overwrite. The test captures the group's
 * current ruleset before writing and restores it in a `finally`, but a process kill / crash mid-run
 * would leave the group holding the test-authored ruleset — never point this at a group anyone
 * depends on. See docs/dynamic-groups.md and tests/fixtures/dynamic/README.md for how to run this.
 */
describe.runIf(live && liveWrite)("dynamic ruleset round-trip pin (#36, live write)", () => {
  it("a user-authored PUT round-trips through GET, and a plan built from it is a no-op", async () => {
    const { client } = await authedSession();

    const expectedHost = process.env.CT_LIVE_WRITE_HOST?.trim();
    if (!expectedHost || client.host !== expectedHost) {
      throw new Error(
        "CT_LIVE_WRITE requires CT_LIVE_WRITE_HOST to be set and to exactly match the authenticated " +
          "host, as a non-production confirmation guard. Refusing to write.",
      );
    }
    if (!GID) {
      throw new Error("CT_DYNAMIC_FIXTURE_GID must be set to a disposable dev dynamic group id.");
    }

    // Capture the group's current ruleset so it can be restored no matter what this test does.
    const before = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);

    try {
      // Authored by hand, right here — NOT copied from a GET — so a server-side rewrite of any of
      // these fields is actually observable.
      const authored = {
        description: `ct-cli #36 pin ${Date.now()}`,
        shorty: "ct-cli-36-pin",
        personIdFieldName: "person.id",
        importance: 7,
        query: {
          method: "ChurchQuery",
          params: {
            groupBy: ["person.id"],
            filter: { "==": [{ var: "person.isArchived" }, false] },
            primaryEntityAlias: "person",
            responseFields: ["person.id"],
          },
        },
        process: {},
      };

      await client.request("PUT", `/dynamicgroups/${GID}/ruleset`, { dynamicGroupRuleSet: authored });
      const after = await client.get<Record<string, unknown>>(`/dynamicgroups/${GID}/ruleset`);

      const wantNorm = normalizeRuleset(authored);
      const gotNorm = normalizeRuleset(after);

      // Field-by-field, not a single blob compare, so a failure names exactly what CT rewrote.
      const allFields = new Set([...Object.keys(wantNorm), ...Object.keys(gotNorm)]);
      const changedFields = [...allFields].filter((f) => !isDeepStrictEqual(wantNorm[f], gotNorm[f]));
      if (changedFields.length > 0) {
        const detail = changedFields
          .map((f) => `  ${f}:\n    authored: ${JSON.stringify(wantNorm[f])}\n    returned: ${JSON.stringify(gotNorm[f])}`)
          .join("\n");
        throw new Error(
          `CT rewrote ${changedFields.length} RuleSet field(s) on PUT — extend normalizeRuleset ` +
            `(src/engine/dynamic.ts) to drop/canonicalize them:\n${detail}`,
        );
      }

      // The property #36 actually protects: a `ct plan` built from this same user-authored desired
      // ruleset is a no-op (empty `dynamic` diff) after the PUT — not just raw-object equality.
      // The `dynamic` field bundles status + ruleset and `diffFields` compares it as one unit, so the
      // desired status must track the group's REAL live status rather than a hardcoded literal —
      // otherwise this assertion would false-fail whenever the fixture group's status isn't exactly
      // "manual" (e.g. the committed fixture at tests/fixtures/dynamic/status.get.json is "active").
      // This test only ever writes the ruleset (never a status PUT), so reading the live status here
      // isolates exactly the #36 property under test — ruleset field rewriting — from status drift.
      const liveStatus = (
        await client.get<{ dynamicGroupStatus?: string }>(`/dynamicgroups/${GID}/status`)
      )?.dynamicGroupStatus ?? "none";
      const state: State = {
        version: 1,
        host: expectedHost,
        resources: { pin36: { type: "group", id: GID, key: "pin36", fields: {}, adoptedAt: "t", updatedAt: "t" } },
      };
      const actual = new Map<string, Record<string, unknown>>([["pin36", {}]]);
      const desired: DesiredResource[] = [
        {
          type: "group",
          key: "pin36",
          fields: {},
          dependsOn: [],
          dynamic: { status: liveStatus as DynamicStatus, ruleset: authored },
        },
      ];
      const folded = await syntheticField("dynamic")!.fold({ client, state, desired, actual });
      expect(folded.errors).toEqual([]);
      const dynamicChange = diffFields(folded.desired[0]!.fields, actual.get("pin36")!).find(
        (c) => c.field === "dynamic",
      );
      expect(dynamicChange, `plan is not a no-op after the PUT: ${JSON.stringify(dynamicChange)}`).toBeUndefined();
    } finally {
      // Restore the prior ruleset so the dev instance isn't left mutated by this test.
      await client.request("PUT", `/dynamicgroups/${GID}/ruleset`, { dynamicGroupRuleSet: normalizeRuleset(before) });
    }
  });
});
