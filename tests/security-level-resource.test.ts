/**
 * Security levels as a managed resource (#110) — ChurchTools' only CALLER-ASSIGNED-ID type.
 *
 * Every other managed type lets CT mint the id and records the mapping in state. A security level
 * is created with `POST /securitylevels/{id}`: the config picks the id, and CT 409s if it is taken.
 * That is not an API quirk to paper over — the id IS the level (person fields carry a
 * `securityLevelId`, grants scope by `cc_securitylevel`), so it has to be reproducible across hosts
 * rather than whatever a fresh instance auto-increments to.
 *
 * Live-probed on eqrm-dev, CT 3.135.2, 2026-08-14 (create id 99 → rename → delete; levels 1–4
 * untouched throughout, instance restored):
 *   POST   /securitylevels/99  {name}  → 200 {"id":99,"name":"…","sortkey":99,"sortKey":99}
 *   PATCH  /securitylevels/99  {name}  → 200 {"id":99,"name":"…"}
 *   DELETE /securitylevels/99          → 200
 */
import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { computePlan } from "../src/engine/plan.js";
import { evaluateConfig } from "../src/config/context.js";
import { RESOURCES, configSnippet, knownFields } from "../src/resources/registry.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan, DesiredResource } from "../src/engine/types.js";

const noSave: (path: string, state: State) => Promise<void> = async () => {};
const fixedNow = () => "2026-08-14T00:00:00.000Z";

function recorder(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return (responses[`${method} ${path}`] ?? {}) as T;
    },
  };
  return { client, calls };
}

/** State holding security level 3 under key `stufe_3_hoch`, as a prior apply would have left it. */
function stateWithLevel3(): State {
  return {
    version: 1,
    host: "h",
    resources: {
      stufe_3_hoch: {
        type: "security-level",
        id: 3,
        key: "stufe_3_hoch",
        fields: { id: 3, name: "Stufe 3 (Hoch)" },
        adoptedAt: "t",
        updatedAt: "t",
      },
    },
  };
}

describe("create posts to the DECLARED id, not the collection (#110)", () => {
  it("POSTs /securitylevels/3 and records id 3 in state", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /securitylevels/3": { id: 3, name: "Stufe 3 (Hoch)" } });
    const plan: Plan = {
      items: [
        {
          type: "security-level",
          key: "stufe_3_hoch",
          id: null,
          action: "create",
          changes: [
            { field: "id", from: undefined, to: 3 },
            { field: "name", from: undefined, to: "Stufe 3 (Hoch)" },
          ],
        },
      ],
    };

    const res = await executePlan(plan, { client, state, statePath: "unused", save: noSave, now: fixedNow });
    expect(res.failed).toBeUndefined();
    expect(res.created).toEqual(["stufe_3_hoch"]);
    // The whole point: the id is in the PATH. A POST to /securitylevels would 404/405 on a live host.
    expect(calls).toEqual([
      { method: "POST", path: "/securitylevels/3", body: { id: 3, name: "Stufe 3 (Hoch)" } },
    ]);
    expect(state.resources.stufe_3_hoch).toMatchObject({ type: "security-level", id: 3 });
  });

  it("leaves every other type posting to its collection path", async () => {
    // The createPath hook must not leak into the normal contract — pinned so a future refactor that
    // makes it unconditional is caught here rather than on a live instance.
    const withCreatePath = Object.entries(RESOURCES)
      .filter(([, spec]) => spec.createPath !== undefined)
      .map(([type]) => type);
    expect(withCreatePath).toEqual(["security-level"]);
    const callerAssigned = Object.entries(RESOURCES)
      .filter(([, spec]) => spec.callerAssignedId)
      .map(([type]) => type);
    expect(callerAssigned).toEqual(["security-level"]);
  });
});

describe("changing a declared id is refused at plan time (#110)", () => {
  const desired = (id: number): DesiredResource[] => [
    { type: "security-level", key: "stufe_3_hoch", fields: { id, name: "Stufe 3 (Hoch)" }, dependsOn: [] },
  ];
  const actual = new Map([["stufe_3_hoch", { id: 3, name: "Stufe 3 (Hoch)" }]]);

  it("throws, naming the renumber semantics rather than emitting a wrong-shaped PATCH", () => {
    // CT models this as PATCH with `newid` + `forcereorder`, which rewrites what every numeric
    // cc_securitylevel scope on the instance grants. A plain PATCH {id: 4} would either 409 or be
    // ignored — a plan that never converges.
    expect(() => computePlan(desired(4), stateWithLevel3(), actual)).toThrow(
      /cannot change id 3 → 4.*RENUMBER.*forcereorder/s,
    );
  });

  it("is a clean no-op when the declared id matches", () => {
    const plan = computePlan(desired(3), stateWithLevel3(), actual);
    expect(plan.items.map((i) => i.action)).toEqual(["no-op"]);
  });

  it("does not fire for a normal minted-id type", () => {
    // `id` is not a managed field anywhere else, so this guard can never touch campuses/groups —
    // but pin it, because the guard reads a field name that exists on every state entry.
    const campusState: State = {
      version: 1,
      host: "h",
      resources: {
        mainz: {
          type: "campus",
          id: 0,
          key: "mainz",
          fields: { name: "Mainz" },
          adoptedAt: "t",
          updatedAt: "t",
        },
      },
    };
    const plan = computePlan(
      [{ type: "campus", key: "mainz", fields: { name: "Mainz 2" }, dependsOn: [] }],
      campusState,
      new Map([["mainz", { name: "Mainz" }]]),
    );
    expect(plan.items.map((i) => i.action)).toEqual(["update"]);
  });
});

describe("adopt → config → plan round-trips to a no-op (#110)", () => {
  it("emits the id in the snippet, and the re-read config diffs clean", async () => {
    // `ct adopt security-level 3` reads the live row through managedFields and emits this snippet.
    const live = { id: 3, name: "Stufe 3 (Hoch)", sortkey: 3, sortKey: 3 };
    const fields = RESOURCES["security-level"]!.managedFields(live);
    expect(fields).toEqual({ id: 3, name: "Stufe 3 (Hoch)" });
    const snippet = configSnippet("security-level", "stufe_3_hoch", fields);
    expect(snippet).toContain("securityLevel(");
    // The id MUST survive adoption — without it the re-applied config could not recreate the level
    // on a fresh host at the same id, which is the whole reason the type is managed.
    expect(snippet).toContain("id: 3");

    const { resources } = await evaluateConfig((ct) => {
      ct.securityLevel({ key: "stufe_3_hoch", id: 3, name: "Stufe 3 (Hoch)" });
    });
    expect(resources[0]?.fields).toEqual({ id: 3, name: "Stufe 3 (Hoch)" });
    const plan = computePlan(resources, stateWithLevel3(), new Map([["stufe_3_hoch", live]]));
    expect(plan.items.map((i) => i.action)).toEqual(["no-op"]);
  });

  it("accepts `id` and `name` as known fields — no unknown-field warning", () => {
    expect(knownFields("security-level")).toEqual(new Set(["id", "name"]));
  });
});

describe("a declared id is REQUIRED and must be a number (#110)", () => {
  // The create POSTs to `/securitylevels/${body.id}`. An omitted id would interpolate the literal
  // string "undefined" into the path, and a string "3" would diff forever against CT's numeric
  // actual — neither is caught by ID_FIELDS (which covers campusId/groupTypeId/groupStatusId only),
  // so eval time is the last place either can be stopped.
  it("rejects a declaration with no id", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.securityLevel({ key: "stufe_5", name: "Stufe 5" });
      }),
    ).rejects.toThrow(/"id" is required and must be a non-negative integer/);
  });

  it("rejects a STRING id rather than posting it and diffing against a number forever", async () => {
    await expect(
      evaluateConfig((ct) => {
        ct.securityLevel({ key: "stufe_5", id: "5", name: "Stufe 5" });
      }),
    ).rejects.toThrow(/"id" is required and must be a non-negative integer/);
  });

  it("leaves every CT-minted-id type alone — a campus needs no declared id", async () => {
    const { resources } = await evaluateConfig((ct) => {
      ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
    });
    expect(resources[0]?.key).toBe("mainz");
  });
});

describe("destroy carries the instance-wide warning (#110)", () => {
  it("names what a delete reaches, the way person-status does", () => {
    const warning = RESOURCES["security-level"]!.destroyWarning;
    expect(warning).toMatch(/every person field and grant scoped to it/);
    expect(warning).toMatch(/ct get security-levels/);
  });
});
