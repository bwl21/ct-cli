import { describe, it, expect } from "vitest";
import { emitAdoptedGrants } from "../src/permissions/adopt.js";
import type { RawPermission } from "../src/permissions/grants.js";
import type { State } from "../src/state/state.js";

const HOST = "https://eqrm.church.tools";

/** A state file with one managed group "kids" at id 99. */
function stateWithKids(): State {
  return {
    version: 1,
    host: HOST,
    resources: {
      kids: { type: "group", id: 99, key: "kids", fields: {}, adoptedAt: "t", updatedAt: "t" },
    },
  };
}

function emptyState(): State {
  return { version: 1, host: HOST, resources: {} };
}

describe("emitAdoptedGrants", () => {
  it("happy path — emits named unscoped grants and the right DSL function", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("ct.groupTypeRole({");
    expect(block).toContain("id: 42,");
    expect(block).toContain('"churchcore:administer settings"');
    // grants are config-only, never a numeric id when the authId is known
    expect(block).not.toContain("authId");
  });

  it("group_role emits ct.groupRole", () => {
    const rows: RawPermission[] = [{ authId: 1, dataId: null, type: "grant", domainId: 7, meta: { modifiedPid: 5 } }];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 7, rows, state: emptyState() });
    expect(block).toContain("ct.groupRole({");
  });

  it("scoped grant whose dataId is a managed group → emits the group's logical key", () => {
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: stateWithKids() });

    expect(block).toContain('{ right: "churchgroup:view group", scope: ["kids"] }');
    expect(block).not.toContain("WARNING");
  });

  it("collapses a multi-scope grant (one CT row per dataId) into one entry", () => {
    const state = stateWithKids();
    state.resources.youth = { type: "group", id: 100, key: "youth", fields: {}, adoptedAt: "t", updatedAt: "t" };
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
      { authId: 1104, dataId: 100, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state });
    expect(block).toContain('{ right: "churchgroup:view group", scope: ["kids", "youth"] }');
  });

  it("scoped grant whose dataId is NOT managed → clearly-marked placeholder comment, no bare key", () => {
    const rows: RawPermission[] = [
      { authId: 1104, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("WARNING: scope target group #777 is not managed");
    expect(block).toContain("ct adopt group 777");
    // the grant is a commented placeholder — never an active line with an invalid/guessed key
    expect(block).toContain("// { right: \"churchgroup:view group\", scope:");
  });

  it("excludes baseline + inherited rows and notes preserved revoke/deny rows", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // kept
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline → excluded
      { authId: 3, dataId: null, type: "grant", domainId: 42, isInherited: true }, // inherited → excluded
      { authId: 1104, dataId: 99, type: "revoke", domainId: 42, meta: { modifiedPid: 5 } }, // deny → preserved, noted
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: stateWithKids() });

    expect(block).toContain('"churchcore:administer settings"'); // authId 1 kept
    expect(block).not.toContain('scope: ["kids"]'); // the revoke row is NOT emitted as a grant
    expect(block).toContain("1 revoke/deny row(s) exist");
    expect(block).toContain("PRESERVES");
  });

  it("unknown authId → numeric + warning comment, does not fail", () => {
    const rows: RawPermission[] = [
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("WARNING: authId 999999 has no catalog entry");
  });

  it("emits an empty grants array when no user-authored grants remain", () => {
    const rows: RawPermission[] = [
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline only
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("grants: [],");
  });
});
