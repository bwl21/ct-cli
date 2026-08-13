/**
 * `ct refresh` (#105) — ask ChurchTools to materialize a dynamic group's membership NOW.
 *
 * `ct apply` writes the ruleset and flips the status; ChurchTools computes the membership on its own
 * schedule. So a freshly created auto-group is legitimately EMPTY after a green apply, which reads as
 * a failure to anyone who does not know the model. `ct apply --refresh` only covers dynamic groups
 * CHANGED in that run, so it cannot re-evaluate an existing group and does nothing at all on a no-op
 * plan — leaving no lever for "it's empty and I want to know whether the ruleset is wrong".
 *
 * Scope is deliberately per-group: `POST /dynamicgroups/{id}/refresh`. ChurchTools also exposes a
 * legacy scheduler ping (`GET /?q=cron&standby=true`) that the admin UI's cron page hits, but that
 * runs EVERY due scheduled job on the instance — far beyond auto-groups — so `ct` documents it (see
 * docs/runbook-manual-surface.md) and never fires it.
 */
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import type { CtClient } from "../api/ctClient.js";
import { CtApiError } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { assertNotPeople } from "../engine/guard.js";
import { loadState, type ManagedResource, type State } from "../state/state.js";
import { error, info, success, warn } from "../ui.js";

interface RefreshOptions {
  state?: string;
  env?: string;
  group?: string;
  all?: boolean;
}

/** The per-group counts CT returns from POST /dynamicgroups/{id}/refresh. */
interface RefreshResult {
  created: number;
  updated: number;
  deleted: number;
}

export function refreshCommand(): Command {
  return new Command("refresh")
    .description(
      "Ask ChurchTools to re-evaluate a managed dynamic group's membership now (does not change config)",
    )
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--group <key>", "refresh this managed group only")
    .option("--all", "refresh every managed dynamic group (required to fan out — this changes membership)")
    .action(async (opts: RefreshOptions) => {
      if (!opts.group && !opts.all) {
        throw new Error(
          "Specify --group <key> for one group, or --all to refresh every managed dynamic group. " +
            "Refreshing recomputes membership, so the fan-out is never the default.",
        );
      }
      if (opts.group && opts.all) {
        throw new Error("Specify only one of: --group, --all.");
      }

      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const state = await loadState(cmdEnv.statePath, config.host);
      const { client } = await authedSession();

      const targets = await selectTargets(client, state, opts.group);
      if (targets.length === 0) {
        info("No managed dynamic groups to refresh.");
        return;
      }

      let failed = 0;
      for (const target of targets) {
        const path = `/dynamicgroups/${target.id}/refresh`;
        assertNotPeople(path);
        try {
          const res = await client.request<RefreshResult[]>("POST", path);
          const r = res?.[0];
          success(
            r
              ? `refreshed ${target.key} (#${target.id}): +${r.created} ~${r.updated} -${r.deleted}`
              : `refreshed ${target.key} (#${target.id})`,
          );
        } catch (err) {
          failed += 1;
          error(
            `Failed to refresh ${target.key} (#${target.id}): ${
              err instanceof CtApiError ? `HTTP ${err.status}` : (err as Error).message
            }`,
          );
        }
      }
      if (failed > 0) process.exitCode = 1;
    });
}

/**
 * Which managed groups to refresh. Refuses a group that is not an auto-group on this host rather than
 * POSTing to an endpoint that will 404 — "this group has no ruleset" is the answer the caller needs.
 */
async function selectTargets(
  client: Pick<CtClient, "getAll">,
  state: State,
  groupKey: string | undefined,
): Promise<ManagedResource[]> {
  const dynamicIds = new Set<number>();
  const { data } = await client.getAll<Record<string, unknown>>("/dynamicgroups");
  for (const row of data) {
    const id = Number(row.id ?? row.groupId);
    if (Number.isFinite(id)) dynamicIds.add(id);
  }

  if (groupKey !== undefined) {
    const managed = state.resources[groupKey];
    if (!managed || managed.type !== "group") {
      throw new Error(
        `--group "${groupKey}" is not a managed group in this state file. Adopt or declare it first.`,
      );
    }
    if (!dynamicIds.has(managed.id)) {
      throw new Error(
        `--group "${groupKey}" (#${managed.id}) is not a dynamic group on this host — there is no ruleset to evaluate.`,
      );
    }
    return [managed];
  }

  const all = Object.values(state.resources).filter((r) => r.type === "group" && dynamicIds.has(r.id));
  // Only ever the MANAGED ones: `ct` never touches a group the config does not own, and the
  // all-groups /dynamicgroups/refresh endpoint (huge blast radius) is deliberately never called.
  if (all.length > 0) warn(`Refreshing ${all.length} managed dynamic group(s) — this recomputes membership.`);
  return all;
}
