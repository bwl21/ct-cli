import { describe, it, expect } from "vitest";
import { executePlan } from "../src/engine/execute.js";
import { emptyState, type State } from "../src/state/state.js";
import type { Plan } from "../src/engine/types.js";
import { CtApiError } from "../src/api/ctClient.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function recorder(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const client = {
    request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      const key = `${method} ${path}`;
      return (responses[key] ?? {}) as T;
    },
  };
  return { client, calls };
}

const noSave: (path: string, state: State) => Promise<void> = async () => {};
const fixedNow = () => "2026-07-07T00:00:00.000Z";

describe("executePlan", () => {
  it("creates a resource, captures its id, and records it in state", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /campuses": { id: 5 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shortName", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.created).toEqual(["zurich"]);
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/campuses",
      body: { name: "Zürich", shortName: "ZH" },
    });
    expect(state.resources.zurich).toMatchObject({
      type: "campus",
      id: 5,
      key: "zurich",
      fields: { name: "Zürich", shortName: "ZH" },
    });
  });

  it("group-type create POST carries the required-but-unmanaged defaults, but state stays managed-only (#73)", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /group/grouptypes": { id: 12 } });
    const plan: Plan = {
      items: [
        {
          type: "group-type",
          key: "dienst",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Dienst" },
            { field: "nameTranslated", from: undefined, to: "Dienst" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toBeUndefined();
    // POST body = declared fields ∪ deterministic create-defaults (declared values win).
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/group/grouptypes",
      body: {
        name: "Dienst",
        nameTranslated: "Dienst",
        namePlural: "Dienst",
        shorty: "Dienst",
        color: "default",
        permissionDepth: 1,
        isLeaderNecessary: false,
        availableForNewPerson: false,
        sortKey: 0,
        postsEnabled: false,
      },
    });
    // State records ONLY the managed fields — the create-defaults stay unmanaged (no future diff).
    expect(state.resources.dienst?.fields).toEqual({ name: "Dienst", nameTranslated: "Dienst" });
  });

  it("a declared value overrides the matching create-default (declared wins over the derived default)", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /group/grouptypes": { id: 3 } });
    const plan: Plan = {
      items: [
        {
          type: "group-type",
          key: "dienst",
          id: null,
          action: "create",
          // `shorty` is unmanaged, but if a caller passes it through it must not be clobbered by the default.
          changes: [
            { field: "name", from: undefined, to: "Dienst" },
            { field: "shorty", from: undefined, to: "DNST" },
          ],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect((calls[0]?.body as Record<string, unknown>).shorty).toBe("DNST");
  });

  it("update of a group-type does NOT inject create-defaults — the PUT body is byte-identical to pre-#73", async () => {
    const state = emptyState("h");
    state.resources.dienst = {
      type: "group-type",
      id: 12,
      key: "dienst",
      fields: { name: "Dienst", nameTranslated: "Dienst" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder({});
    const plan: Plan = {
      items: [
        {
          type: "group-type",
          key: "dienst",
          id: 12,
          action: "update",
          actual: { name: "Dienst", nameTranslated: "Dienst" },
          changes: [{ field: "name", from: "Dienst", to: "Dienstteam" }],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    // PUT replaces the whole object with actual ∪ changes — and carries NONE of the create-defaults.
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/group/grouptypes/12",
      body: { name: "Dienstteam", nameTranslated: "Dienst" },
    });
  });

  it("group-role create POST carries the required `shorty` default (#73 audit)", async () => {
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /group/roles": { id: 4 } });
    const plan: Plan = {
      items: [
        {
          type: "group-role",
          key: "leiter",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Verantwortlicher" },
            { field: "groupTypeId", from: undefined, to: 2 },
          ],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/group/roles",
      // `type`/`isDefault`/`isHidden` are create-only defaults CT validates (#121) — sent on the
      // POST, absent from state, so they are never diffed or reverted afterwards.
      body: {
        name: "Verantwortlicher",
        groupTypeId: 2,
        shorty: "Verantwort",
        type: "participant",
        isDefault: false,
        isHidden: false,
      },
    });
    expect(state.resources.leiter?.fields).toEqual({ name: "Verantwortlicher", groupTypeId: 2 });
  });

  it("recreates a vanished resource: the new id takes over the key instead of colliding on the stale entry", async () => {
    // Resource deleted out-of-band in CT but still in state → computePlan emits a create item
    // while the stale entry (old id 5) is still under this key. The create must replace it.
    const state = emptyState("h");
    state.resources.zurich = {
      type: "campus",
      id: 5,
      key: "zurich",
      fields: { name: "Zürich", shorty: "ZH" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client } = recorder({ "POST /campuses": { id: 8 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "Zürich" },
            { field: "shorty", from: undefined, to: "ZH" },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["zurich"]);
    expect(state.resources.zurich).toMatchObject({ id: 8, key: "zurich" });
  });

  it("updates a group via PATCH with only the changed field (siblings left alone)", async () => {
    const state = emptyState("h");
    state.resources.team = {
      type: "group",
      id: 9,
      key: "team",
      fields: { name: "Team", groupTypeId: 2, groupStatusId: 1 },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "team",
          id: 9,
          action: "update",
          changes: [{ field: "name", from: "Team", to: "Team A" }],
          actual: { name: "Team", groupTypeId: 2, groupStatusId: 1 },
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.updated).toEqual(["team"]);
    // PATCH carries ONLY the planned change — CT keeps the untouched siblings.
    expect(calls[0]).toEqual({
      method: "PATCH",
      path: "/groups/9",
      body: { name: "Team A" },
    });
    // Post-apply state reflects what CT now holds: actual ∪ changes.
    expect(state.resources.team!.fields).toEqual({ name: "Team A", groupTypeId: 2, groupStatusId: 1 });
  });

  it("assigns a campus by PATCHing a top-level campusId (#21)", async () => {
    const state = emptyState("h");
    state.resources.team = {
      type: "group",
      id: 9,
      key: "team",
      fields: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: null },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "team",
          id: 9,
          action: "update",
          changes: [{ field: "campusId", from: null, to: 4 }],
          actual: { name: "Team", groupTypeId: 2, groupStatusId: 1, campusId: null },
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.updated).toEqual(["team"]);
    // CT reads campus at information.campusId but accepts a top-level campusId on PATCH — mirroring
    // how groupTypeId/groupStatusId are written. PATCH carries only the changed field.
    expect(calls[0]).toEqual({ method: "PATCH", path: "/groups/9", body: { campusId: 4 } });
    expect(state.resources.team!.fields).toEqual({
      name: "Team",
      groupTypeId: 2,
      groupStatusId: 1,
      campusId: 4,
    });
  });

  it("does NOT revert a field that drifted in CT when a sibling field is updated (#27)", async () => {
    // Campus adopted with { name, shorty }; an admin edited `shorty` in the CT UI after adoption,
    // so state carries the adopt-time "MZ" while the fetched actual is "MZX". The user changed `name`.
    const state = emptyState("h");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz", shorty: "MZ" }, // stale adopt-time snapshot
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "mainz",
          id: 0,
          action: "update",
          changes: [{ field: "name", from: "Mainz", to: "Mainz HQ" }],
          actual: { name: "Mainz", shorty: "MZX" }, // shorty drifted in CT
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    // PUT replaces the whole object, so it must carry the drifted actual `shorty`, never the stale "MZ".
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/campuses/0",
      body: { name: "Mainz HQ", shorty: "MZX" },
    });
    // Post-apply state reflects the written body, not the stale snapshot.
    expect(state.resources.mainz!.fields).toEqual({ name: "Mainz HQ", shorty: "MZX" });
  });

  it("reconciles hierarchy edges via PUT/DELETE and never stores parents in state", async () => {
    const state = emptyState("h");
    state.resources.parent = {
      type: "group",
      id: 1,
      key: "parent",
      fields: { name: "P" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    state.resources.child = {
      type: "group",
      id: 2,
      key: "child",
      fields: { name: "C" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "child",
          id: 2,
          action: "update",
          changes: [{ field: "parents", from: [], to: ["parent"] }],
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(calls).toEqual([{ method: "PUT", path: "/groups/2/parents/1", body: undefined }]);
    expect(state.resources.child!.fields.parents).toBeUndefined();
  });

  it("writes hierarchy edges on a first apply (creates carry a parents change) (#28)", async () => {
    // Fresh state: parent + child both created in dependency order, and the child's create carries
    // a `parents` change so the edge is written on the very first apply.
    const state = emptyState("h");
    const { client, calls } = recorder({ "POST /groups": { id: 0 } });
    // Return distinct ids for the two POSTs so resolveId can find the parent.
    let nextId = 1;
    client.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      if (method === "POST" && path === "/groups") return { id: nextId++ } as T;
      return {} as T;
    };
    const plan: Plan = {
      items: [
        {
          type: "group",
          key: "parent",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "parent" }],
        },
        {
          type: "group",
          key: "child",
          id: null,
          action: "create",
          changes: [
            { field: "name", from: undefined, to: "child" },
            { field: "parents", from: undefined, to: ["parent"] },
          ],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toBeUndefined();
    expect(result.created).toEqual(["parent", "child"]);
    // The edge PUT resolves the parent's freshly-assigned id (1) against the child's (2).
    expect(calls).toContainEqual({ method: "PUT", path: "/groups/2/parents/1", body: undefined });
  });

  it("mirrors config preventDestroy onto the state entry on create (#17 item 2)", async () => {
    const state = emptyState("h");
    const { client } = recorder({ "POST /campuses": { id: 5 } });
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Zürich" }],
          preventDestroy: true,
        },
      ],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
    expect(state.resources.zurich!.preventDestroy).toBe(true);
  });

  it("persists a preventDestroy toggle even when nothing else changed (no-op) (#17 item 2)", async () => {
    const state = emptyState("h");
    state.resources.mainz = {
      type: "campus",
      id: 0,
      key: "mainz",
      fields: { name: "Mainz" },
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client } = recorder();
    let saved = 0;
    const save = async () => {
      saved++;
    };
    // A note-less no-op whose config now sets preventDestroy — the flag alone is never a diffed field,
    // so this is the only chance to persist it to state.
    const plan: Plan = {
      items: [{ type: "campus", key: "mainz", id: 0, action: "no-op", changes: [], preventDestroy: true }],
    };
    await executePlan(plan, { client, state, statePath: "s.json", save, now: fixedNow });
    expect(state.resources.mainz!.preventDestroy).toBe(true);
    expect(saved).toBe(1); // saved exactly once, because the flag actually changed

    // Dropping the flag from config clears it (config → state is the source of truth for protection).
    const clearPlan: Plan = {
      items: [{ type: "campus", key: "mainz", id: 0, action: "no-op", changes: [] }],
    };
    await executePlan(clearPlan, { client, state, statePath: "s.json", save, now: fixedNow });
    expect(state.resources.mainz!.preventDestroy).toBeUndefined();
  });

  it("skips deletes (apply never deletes)", async () => {
    const state = emptyState("h");
    state.resources.old = {
      type: "campus",
      id: 3,
      key: "old",
      fields: {},
      adoptedAt: "t",
      updatedAt: "t",
    };
    const { client, calls } = recorder();
    const plan: Plan = { items: [{ type: "campus", key: "old", id: 3, action: "delete", changes: [] }] };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.skippedDeletes).toEqual(["old"]);
    expect(calls).toEqual([]);
    expect(state.resources.old).toBeDefined();
  });

  it("stops on the first write error and reports it", async () => {
    const state = emptyState("h");
    const client = {
      request: async <T>(): Promise<T> => {
        throw new Error("boom");
      },
    };
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "zurich",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Z" }],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed).toEqual({ key: "zurich", message: "boom" });
    expect(result.created).toEqual([]);
  });

  it("renders a CtApiError's HTTP status + body in the stop message, via the shared formatter (#71)", async () => {
    const state = emptyState("h");
    const client = {
      request: async <T>(): Promise<T> => {
        throw new CtApiError("POST /group/grouptypes failed", 403, {
          message: "no permission to create group types",
        });
      },
    };
    const plan: Plan = {
      items: [
        {
          type: "campus",
          key: "struktur",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "S" }],
        },
      ],
    };
    const result = await executePlan(plan, {
      client,
      state,
      statePath: "s.json",
      save: noSave,
      now: fixedNow,
    });
    expect(result.failed?.key).toBe("struktur");
    expect(result.failed?.message).toContain("HTTP 403");
    expect(result.failed?.message).toContain("no permission to create group types");
  });

  describe("allowDuplicateName / force create opt-in (#75)", () => {
    it("sends force: true on the CREATE POST body when a create item opts in", async () => {
      const state = emptyState("h");
      const { client, calls } = recorder({ "POST /groups": { id: 7 } });
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids_2026_b",
            id: null,
            action: "create",
            changes: [
              { field: "name", from: undefined, to: "Kids Elternabend 2026" },
              { field: "groupTypeId", from: undefined, to: 2 },
            ],
            allowDuplicateName: true,
          },
        ],
      };
      const result = await executePlan(plan, {
        client,
        state,
        statePath: "s.json",
        save: noSave,
        now: fixedNow,
      });
      expect(result.failed).toBeUndefined();
      expect(calls[0]).toEqual({
        method: "POST",
        path: "/groups",
        body: { name: "Kids Elternabend 2026", groupTypeId: 2, force: true },
      });
      // force is create-body only — never stored as a managed field.
      expect(state.resources.kids_2026_b?.fields).toEqual({
        name: "Kids Elternabend 2026",
        groupTypeId: 2,
      });
    });

    it("omits force from the CREATE POST body when not opted in", async () => {
      const state = emptyState("h");
      const { client, calls } = recorder({ "POST /groups": { id: 7 } });
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids_2026_a",
            id: null,
            action: "create",
            changes: [{ field: "name", from: undefined, to: "Kids Elternabend 2026" }],
          },
        ],
      };
      await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
      expect(calls[0]).toEqual({
        method: "POST",
        path: "/groups",
        body: { name: "Kids Elternabend 2026" },
      });
    });

    it("never sends force on the UPDATE path, even if a stale item somehow carried the flag", async () => {
      const state = emptyState("h");
      state.resources.team = {
        type: "group",
        id: 9,
        key: "team",
        fields: { name: "Team" },
        adoptedAt: "t",
        updatedAt: "t",
      };
      const { client, calls } = recorder();
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "team",
            id: 9,
            action: "update",
            changes: [{ field: "name", from: "Team", to: "Team A" }],
            actual: { name: "Team" },
            allowDuplicateName: true,
          },
        ],
      };
      await executePlan(plan, { client, state, statePath: "s.json", save: noSave, now: fixedNow });
      expect(calls[0]).toEqual({ method: "PATCH", path: "/groups/9", body: { name: "Team A" } });
    });

    it("appends adoption/opt-in guidance to the stop message on a duplicate-name 400 (messageKey) without the flag", async () => {
      const state = emptyState("h");
      const client = {
        request: async <T>(): Promise<T> => {
          throw new CtApiError("POST /groups failed", 400, {
            message: "Duplicate found. Use force flag to create group with same name.",
            messageKey: "forbidden.duplicate.group",
            translatedMessage: "Duplikat gefunden. Nutze das force Flag um die Gruppe trotzdem anzulegen.",
            args: [],
            errors: [],
          });
        },
      };
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids_2026_b",
            id: null,
            action: "create",
            changes: [{ field: "name", from: undefined, to: "Kids Elternabend 2026" }],
          },
        ],
      };
      const result = await executePlan(plan, {
        client,
        state,
        statePath: "s.json",
        save: noSave,
        now: fixedNow,
      });
      expect(result.failed?.key).toBe("kids_2026_b");
      // The shared formatter's output is preserved verbatim (HTTP status + body)...
      expect(result.failed?.message).toContain("HTTP 400");
      expect(result.failed?.message).toContain("forbidden.duplicate.group");
      // ...with one guidance line appended, naming both remedies.
      expect(result.failed?.message).toContain("ct adopt group <id>");
      expect(result.failed?.message).toContain("--key kids_2026_b");
      expect(result.failed?.message).toContain("allowDuplicateName: true");
    });

    it("also recognises the duplicate-group guard from the 400 message text alone (no messageKey)", async () => {
      const state = emptyState("h");
      const client = {
        request: async <T>(): Promise<T> => {
          throw new CtApiError("POST /groups failed", 400, {
            message: "Duplicate found. Use force flag to create group with same name.",
          });
        },
      };
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids_2026_b",
            id: null,
            action: "create",
            changes: [{ field: "name", from: undefined, to: "K" }],
          },
        ],
      };
      const result = await executePlan(plan, {
        client,
        state,
        statePath: "s.json",
        save: noSave,
        now: fixedNow,
      });
      expect(result.failed?.message).toContain("allowDuplicateName: true");
    });

    it("does NOT append guidance when the create already opted in with allowDuplicateName", async () => {
      const state = emptyState("h");
      const client = {
        request: async <T>(): Promise<T> => {
          throw new CtApiError("POST /groups failed", 400, {
            message: "Duplicate found. Use force flag to create group with same name.",
            messageKey: "forbidden.duplicate.group",
          });
        },
      };
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids_2026_b",
            id: null,
            action: "create",
            changes: [{ field: "name", from: undefined, to: "K" }],
            allowDuplicateName: true,
          },
        ],
      };
      const result = await executePlan(plan, {
        client,
        state,
        statePath: "s.json",
        save: noSave,
        now: fixedNow,
      });
      expect(result.failed?.message).not.toContain("Guidance:");
    });

    it("does NOT append duplicate-group guidance for an unrelated 400 (e.g. a validation error)", async () => {
      const state = emptyState("h");
      const client = {
        request: async <T>(): Promise<T> => {
          throw new CtApiError("POST /groups failed", 400, { message: "name must not be empty" });
        },
      };
      const plan: Plan = {
        items: [
          {
            type: "group",
            key: "kids",
            id: null,
            action: "create",
            changes: [{ field: "name", from: undefined, to: "" }],
          },
        ],
      };
      const result = await executePlan(plan, {
        client,
        state,
        statePath: "s.json",
        save: noSave,
        now: fixedNow,
      });
      expect(result.failed?.message).not.toContain("Guidance:");
    });
  });
});
