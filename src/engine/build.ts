/**
 * Shared plan building: fetch the actual ChurchTools values of every managed
 * resource, fold synthetic sub-resource fields (group hierarchy's `parents`, …)
 * into the diff, and diff against the desired config + state. Used by both
 * `ct plan` and `ct apply`, so apply fetches exactly once (its `actual` map is
 * reused for the backup).
 */
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import type { State } from "../state/state.js";
import type { DesiredResource, Plan } from "./types.js";
import { RESOURCES } from "../resources/registry.js";
import { computePlan } from "./plan.js";
import { foldSynthetic } from "./synthetic.js";
import { mapConcurrent } from "../util/concurrency.js";
import { warn } from "../ui.js";

/** How many managed resources to fetch from ChurchTools at once. */
const FETCH_CONCURRENCY = 8;

export interface BuildResult {
  plan: Plan;
  actual: Map<string, Record<string, unknown>>;
  fetchErrors: string[];
}

export interface BuildOptions {
  /** Directory of the config file — `{ ref }` ruleset paths resolve relative to it (not the cwd). */
  configDir?: string;
}

export async function buildPlan(
  client: Pick<CtClient, "get">,
  state: State,
  desired: DesiredResource[],
  opts: BuildOptions = {},
): Promise<BuildResult> {
  // Keyed by logical key (globally unique), not CT id (unique only within a type — the Mainz campus is id 0).
  const actual = new Map<string, Record<string, unknown>>();
  const unresolved = new Set<string>();
  // Keys whose fetch errored (non-404), mapped to a short status descriptor for the plan render.
  const fetchFailed = new Map<string, string>();
  const fetchErrors: string[] = [];

  await mapConcurrent(Object.values(state.resources), FETCH_CONCURRENCY, async (managed) => {
    const spec = RESOURCES[managed.type];
    if (!spec) {
      unresolved.add(managed.key);
      warn(
        `No registry entry for managed type "${managed.type}" (${managed.type}.${managed.key} #${managed.id}) — cannot diff; leaving untouched.`,
      );
      return;
    }
    try {
      const raw = await client.get<Record<string, unknown>>(spec.itemPath(managed.id));
      actual.set(managed.key, spec.managedFields(raw));
    } catch (err) {
      if (err instanceof CtApiError && err.status === 404) {
        return; // vanished in CT — the plan will propose recreating (or pruning) it
      }
      // A read-only plan should not abort on one bad fetch: record it, keep going, flag the plan as partial.
      // Track the key separately from a real 404 so computePlan renders it as a fetch failure, not a recreate.
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof CtApiError ? String(err.status) : "error";
      fetchFailed.set(managed.key, status);
      fetchErrors.push(`${managed.type}.${managed.key} (#${managed.id}): ${message}`);
      warn(`Failed to fetch ${managed.type}.${managed.key} (#${managed.id}): ${message}`);
    }
  });

  // Synthetic sub-resource fields (parents, dynamic, …) fold into the diff on both sides.
  const folded = await foldSynthetic({ client, state, desired, actual, configDir: opts.configDir });
  fetchErrors.push(...folded.errors);
  const plan = computePlan(folded.desired, state, actual, { unresolved, fetchFailed });
  return { plan, actual, fetchErrors };
}
