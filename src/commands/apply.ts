import { dirname, join } from "node:path";
import { Command } from "commander";
import type { CtClient } from "../api/ctClient.js";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { loadState, resolveStatePath, saveState, type State } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { executePlan } from "../engine/execute.js";
import { writeBackup } from "../engine/backup.js";
import { renderPlan } from "../engine/render.js";
import { summarize, type Plan } from "../engine/types.js";
import { assertNotPeople } from "../engine/guard.js";
import { buildPermissionPlan } from "../permissions/plan.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { applyPermissionPlan } from "../permissions/apply.js";
import { confirm } from "../ui/prompt.js";
import { resolveWithEnv } from "../util/resolve.js";
import { info, warn, success, error } from "../ui.js";

interface ApplyOptions {
  config?: string;
  state?: string;
  backupDir?: string;
  autoApprove?: boolean;
  refresh?: boolean;
}

interface RefreshResult {
  created: number;
  updated: number;
  deleted: number;
}

/**
 * Post-apply dynamic-group refresh (opt-in via `--refresh`). For each applied
 * item whose changes touched the `dynamic` synthetic field, POST the
 * per-group `/dynamicgroups/{id}/refresh` endpoint to materialize computed
 * membership. Deliberately per-group only — the all-groups
 * `/dynamicgroups/refresh` endpoint has a huge blast radius and must never be
 * called from here.
 *
 * The id is read from state (post-apply, so creates have their real id) using
 * an explicit `undefined` check — CT ids can legitimately be `0`.
 */
export async function refreshChangedDynamicGroups(
  plan: Plan,
  state: State,
  client: Pick<CtClient, "request">,
): Promise<void> {
  for (const item of plan.items) {
    if (item.action === "no-op" || item.action === "delete") continue;
    const dynamicChange = item.changes.find((c) => c.field === "dynamic");
    if (!dynamicChange) continue;
    const to = dynamicChange.to as { status?: string } | undefined;
    if (to?.status === "none") continue; // demoted to a non-dynamic group — nothing to refresh
    const id = state.resources[item.key]?.id;
    if (id === undefined) continue;
    const path = `/dynamicgroups/${id}/refresh`;
    assertNotPeople(path);
    try {
      const res = await client.request<RefreshResult[]>("POST", path);
      const r = res?.[0];
      if (r) info(`refreshed ${item.key}: +${r.created} ~${r.updated} -${r.deleted}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warn(`Failed to refresh ${item.key} (#${id}): ${message}`);
    }
  }
}

/** backups/ dir: explicit flag → CT_BACKUP_DIR → `backups/` beside the state file. */
export function resolveBackupDir(
  explicit: string | undefined,
  statePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveWithEnv(explicit, env.CT_BACKUP_DIR, join(dirname(statePath), "backups"));
}

export function applyCommand(): Command {
  return new Command("apply")
    .description("Apply the plan: idempotent create + update in dependency order (never deletes)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--backup-dir <path>", "directory for the pre-apply backup (or set CT_BACKUP_DIR)")
    .option("-y, --auto-approve", "skip the confirmation prompt")
    .option(
      "--refresh",
      "after a successful apply, POST /dynamicgroups/{id}/refresh for each changed dynamic group (per-group only)",
    )
    .action(async (opts: ApplyOptions) => {
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const statePath = resolveStatePath(opts.state);
      const { resources: desired, permissions, configDir } = await loadConfig(configPath);
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();
      const { plan, actual, fetchErrors } = await buildPlan(client, state, desired, { configDir });
      const { items: permItems, fetchErrors: permFetchErrors } = await buildPermissionPlan(client, state, permissions, desired);

      const allFetchErrors = [...fetchErrors, ...permFetchErrors];
      if (allFetchErrors.length > 0) {
        error(
          `Aborting: ${allFetchErrors.length} resource(s) could not be fetched — the plan is incomplete. Re-run when resolved.`,
        );
        process.exitCode = 1;
        return;
      }

      process.stdout.write(`${renderPlan(plan)}\n`);
      if (permItems.length > 0) {
        process.stdout.write(`\n${renderPermissionPlan(permItems)}\n`);
      }

      const deletes = plan.items.filter((i) => i.action === "delete");
      if (deletes.length > 0) {
        warn(`${deletes.length} resource(s) dropped from config will NOT be deleted by apply:`);
        for (const d of deletes) {
          info(`    ${d.type}.${d.key} (#${d.id}) — run: ct destroy --target ${d.key}`);
        }
      }

      const s = summarize(plan);
      const permChangeCount = permItems.reduce(
        (n, i) => n + i.diff.toPut.length + i.diff.toDelete.length,
        0,
      );
      const changeCount = s.create + s.update + permChangeCount;
      if (changeCount === 0) {
        success("No changes to apply.");
        return;
      }

      const ok = await confirm(`Apply ${changeCount} change(s)?`, { assumeYes: opts.autoApprove });
      if (!ok) {
        warn("Aborted — no changes made.");
        process.exitCode = 1;
        return;
      }

      const backupPath = await writeBackup(
        resolveBackupDir(opts.backupDir, statePath),
        config.host,
        actual,
      );
      info(`Backup written: ${backupPath}`);

      const result = await executePlan(plan, { client, state, statePath, save: saveState });
      success(`Applied: ${result.created.length} created, ${result.updated.length} updated.`);
      if (result.failed) {
        error(
          `Stopped at ${result.failed.key}: ${result.failed.message}. State saved up to this point — re-run to resume.`,
        );
        process.exitCode = 1;
        return;
      }

      // Re-resolve scope dataIds against the POST-execute state (executePlan has upserted every
      // created/recreated group's real id) so grants are never written with a stale/pending id.
      const permResult = await applyPermissionPlan(permItems, client, state);
      if (permResult.granted > 0 || permResult.deleted > 0) {
        success(`Permissions applied: ${permResult.granted} granted, ${permResult.deleted} deleted.`);
      }

      if (opts.refresh) {
        await refreshChangedDynamicGroups(plan, state, client);
      }
    });
}
