import { describe, it, expect } from "vitest";
import { emitAdoptedGrants } from "../src/permissions/adopt.js";
import type { DomainType, RawPermission } from "../src/permissions/grants.js";
import { desiredTuples } from "../src/permissions/plan.js";
import type { Grant } from "../src/permissions/types.js";
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

/**
 * Parse the ACTIVE (non-comment) grant entries back out of an emitted block, so they can be fed
 * through the real `desiredTuples` — the round-trip property the emitter guarantees.
 */
function parseEmittedGrants(block: string): Grant[] {
  const lines = block.split("\n");
  const start = lines.findIndex((l) => l.trim() === "grants: [");
  if (start === -1) return []; // "grants: []," — nothing emitted
  const grants: Grant[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line === "],") break;
    if (line.startsWith("//")) continue;
    const entry = line.replace(/,$/, "");
    if (entry.startsWith('"')) {
      grants.push(JSON.parse(entry) as string);
      continue;
    }
    const m = /^\{ right: ("(?:[^"\\]|\\.)*"), scope: \[(.*)\] \}$/.exec(entry);
    if (!m?.[1] || m[2] == null) throw new Error(`Unparseable emitted grant line: ${line}`);
    grants.push({ right: JSON.parse(m[1]) as string, scope: JSON.parse(`[${m[2]}]`) as string[] });
  }
  return grants;
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

  it("unknown authId → warning comment only (numeric rights are undeclarable), does not fail", () => {
    const rows: RawPermission[] = [
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain("WARNING: authId 999999 has no catalog entry");
    expect(parseEmittedGrants(block)).toEqual([]); // comment only, no active grant line
  });

  it("emits an empty grants array when no user-authored grants remain", () => {
    const rows: RawPermission[] = [
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline only
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 42, rows, state: emptyState() });
    expect(block).toContain("grants: [],");
  });

  it("group_type_role right with authId >= 10000 → NOTE comment, never an active grant", () => {
    // "churchdb:+edit group infos" (authId 10122) — desiredTuples rejects it on group_type_role.
    const rows: RawPermission[] = [
      { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('NOTE: "churchdb:+edit group infos" (authId 10122) is not writable on group_type_role');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("group_role right with authId >= 10000 IS emitted (only group_type_role rejects it)", () => {
    const rows: RawPermission[] = [
      { authId: 10122, dataId: null, type: "grant", domainId: 7, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_role", domainId: 7, rows, state: emptyState() });
    expect(parseEmittedGrants(block)).toEqual(["churchdb:+edit group infos"]);
  });

  it("scoped right granted globally (dataId null) → WARNING comment, never a bare string", () => {
    // A bare string for a scoped right is rejected by desiredTuples (silent-global-grant guard).
    const rows: RawPermission[] = [
      { authId: 1104, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('WARNING: "churchgroup:view group" is granted GLOBALLY here');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("unscoped right carrying dataIds (stale catalog) → WARNING comment, never a scope", () => {
    const rows: RawPermission[] = [
      { authId: 1, dataId: 55, type: "grant", domainId: 42, meta: { modifiedPid: 5 } },
    ];
    const block = emitAdoptedGrants({ domainType: "group_type_role", domainId: 42, rows, state: emptyState() });

    expect(block).toContain('WARNING: "churchcore:administer settings" is unscoped per the catalog');
    expect(parseEmittedGrants(block)).toEqual([]);
  });

  it("header warns that comment-only grants will be REVOKED on apply — and only when some exist", () => {
    const dirty = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows: [
        { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unknown
        { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // GTR-unwritable
      ],
      state: emptyState(),
    });
    expect(dirty).toContain("WARNING: 2 live grant(s) could not be expressed as config");
    expect(dirty).toContain("REVOKE");

    const clean = emitAdoptedGrants({
      domainType: "group_type_role",
      domainId: 42,
      rows: [{ authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }],
      state: emptyState(),
    });
    expect(clean).not.toContain("REVOKE");
  });

  it("round trip — every emitted grant passes the real desiredTuples, for any mix of rows", () => {
    const state = stateWithKids();
    const rows: RawPermission[] = [
      { authId: 1, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // known unscoped
      { authId: 1, dataId: 55, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unscoped w/ dataId (stale catalog)
      { authId: 1104, dataId: 99, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, managed
      { authId: 1104, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, GLOBAL
      { authId: 1112, dataId: 777, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // scoped, unmanaged
      { authId: 999999, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // unknown authId
      { authId: 10122, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: 5 } }, // >= 10000
      { authId: 2, dataId: null, type: "grant", domainId: 42, meta: { modifiedPid: -1 } }, // baseline
      { authId: 3, dataId: null, type: "grant", domainId: 42, isInherited: true }, // inherited
      { authId: 1112, dataId: 99, type: "revoke", domainId: 42, meta: { modifiedPid: 5 } }, // deny
    ];
    for (const domainType of ["group_role", "group_type_role"] as DomainType[]) {
      const block = emitAdoptedGrants({ domainType, domainId: 42, rows, state });
      const grants = parseEmittedGrants(block);
      expect(grants.length).toBeGreaterThan(0); // the property is not vacuous
      expect(() =>
        desiredTuples({ key: "adopted", domainType, domainId: 42, grants }, state),
      ).not.toThrow();
    }
  });
});
