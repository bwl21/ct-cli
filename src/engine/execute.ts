/**
 * The executor: walk a computed plan and make it real. Field-agnostic — every
 * resource's write path/verb comes from the registry, so adding a type never
 * touches this file. State is saved after each successful action, so a crash
 * mid-apply leaves a consistent, resumable state file.
 *
 * apply NEVER deletes: delete items are recorded and skipped. Synthetic
 * sub-resource fields (group hierarchy's `parents`, …) are reconciled through
 * their own dedicated endpoints, not the owning resource's body — see synthetic.ts.
 */
import type { CtClient } from "../api/ctClient.js";
import type { ManagedResource, State } from "../state/state.js";
import { upsert, saveState } from "../state/state.js";
import type { FieldChange, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { assertNotPeople } from "./guard.js";
import { isSyntheticField, syntheticField } from "./synthetic.js";
import { reresolvePendingValue } from "../resolve/resolver.js";
import { hasPendingRef } from "../resolve/refs.js";

export interface ExecuteDeps {
  client: Pick<CtClient, "request">;
  state: State;
  statePath: string;
  now?: () => string;
  save?: (path: string, state: State) => Promise<void>;
}

export interface ExecuteResult {
  created: string[];
  updated: string[];
  skippedDeletes: string[];
  failed?: { key: string; message: string };
}

/** Mirror the config's `preventDestroy` onto a state entry (kept absent, not `false`, when unset). */
function mirrorPreventDestroy(entry: ManagedResource, flag: boolean | undefined): void {
  if (flag) entry.preventDestroy = true;
  else delete entry.preventDestroy;
}

/** The managed field snapshot after a write: base ∪ changed fields, minus any synthetic sub-resource fields. */
function snapshotFromChanges(base: Record<string, unknown>, changes: FieldChange[]): Record<string, unknown> {
  const snap = { ...base };
  for (const c of changes) if (!isSyntheticField(c.field)) snap[c.field] = c.to;
  for (const f of Object.keys(snap)) if (isSyntheticField(f)) delete snap[f];
  return snap;
}

async function applySyntheticFields(
  client: Pick<CtClient, "request">, state: State, id: number, changes: FieldChange[],
): Promise<void> {
  for (const c of changes) {
    const f = syntheticField(c.field);
    if (f) await f.apply({ client, state, id, change: c });
  }
}

export async function executePlan(plan: Plan, deps: ExecuteDeps): Promise<ExecuteResult> {
  const { client, state, statePath } = deps;
  // Re-resolve any pending logical reference (#20) against the current state before a body/snapshot
  // is used. Tier ordering guarantees a referenced target (e.g. a same-run campus, tier 0) is already
  // in state by the time its referencer (a group, tier 1) applies. No-op when nothing is pending.
  const reresolve = (fields: Record<string, unknown>): Record<string, unknown> =>
    hasPendingRef(fields) ? (reresolvePendingValue(fields, state) as Record<string, unknown>) : fields;
  const now = deps.now ?? (() => new Date().toISOString());
  const save = deps.save ?? saveState;
  const created: string[] = [];
  const updated: string[] = [];
  const skippedDeletes: string[] = [];

  for (const item of plan.items) {
    if (item.action === "delete") {
      skippedDeletes.push(item.key);
      continue;
    }
    if (item.action === "no-op") {
      // A preventDestroy toggle alone yields a no-op plan (the flag is never a diffed field),
      // so reconcile it here too — otherwise adding protection wouldn't reach state until some
      // other field changed. Only clean (note-less) no-ops are desired-side and safe to touch;
      // stale/unresolved/fetch-failed no-ops are delete-side or undiffable — leave them alone.
      const entry = state.resources[item.key];
      if (!item.note && entry && entry.preventDestroy !== (item.preventDestroy || undefined)) {
        mirrorPreventDestroy(entry, item.preventDestroy);
        await save(statePath, state);
      }
      continue;
    }
    const spec = RESOURCES[item.type];
    if (!spec) {
      return {
        created,
        updated,
        skippedDeletes,
        failed: { key: item.key, message: `No write spec for type "${item.type}".` },
      };
    }

    try {
      if (item.action === "create") {
        const body = reresolve(snapshotFromChanges({}, item.changes));
        assertNotPeople(spec.collectionPath);
        const res = await client.request<{ id: number }>("POST", spec.collectionPath, body);
        if (typeof res.id !== "number") {
          throw new Error(`create returned no numeric id (got ${JSON.stringify(res.id)})`);
        }
        // A "recreate" create item (resource vanished from CT but still in state) leaves the
        // stale entry — with the *old* id — under this key. upsert would read the new id as a
        // key collision and throw, so the just-created resource never lands in state and every
        // re-run POSTs another duplicate. Drop the stale entry: a create owns its key outright.
        delete state.resources[item.key];
        upsert(state, { type: item.type, id: res.id, key: item.key, fields: body }, now());
        mirrorPreventDestroy(state.resources[item.key]!, item.preventDestroy);
        await save(statePath, state);
        await applySyntheticFields(client, state, res.id, item.changes);
        created.push(item.key);
      } else {
        const id = item.id;
        if (id === null) {
          throw new Error("update item has no id");
        }
        // Base the write body on the FETCHED ACTUAL, not the stale state snapshot: a field that
        // drifted in the CT UI but isn't in `changes` must pass through, never be reverted (#27).
        // The post-write snapshot (actual ∪ changes) is what CT holds afterward, so state records
        // exactly that regardless of verb.
        const actualFields = item.actual ?? state.resources[item.key]?.fields ?? {};
        const snapshot = reresolve(snapshotFromChanges(actualFields, item.changes));
        const hasFieldChange = item.changes.some((c) => !isSyntheticField(c.field));
        if (hasFieldChange) {
          // PATCH resources take only the changed fields (unchanged/drifted siblings are left alone);
          // PUT resources replace the whole object, so send actual ∪ changes to preserve those siblings.
          const body = spec.updateMethod === "PATCH" ? reresolve(snapshotFromChanges({}, item.changes)) : snapshot;
          const path = spec.itemPath(id);
          assertNotPeople(path);
          await client.request(spec.updateMethod, path, body);
        }
        upsert(state, { type: item.type, id, key: item.key, fields: snapshot }, now());
        mirrorPreventDestroy(state.resources[item.key]!, item.preventDestroy);
        await save(statePath, state);
        await applySyntheticFields(client, state, id, item.changes);
        updated.push(item.key);
      }
    } catch (err) {
      return {
        created,
        updated,
        skippedDeletes,
        failed: { key: item.key, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  return { created, updated, skippedDeletes };
}
