import { dirname, join } from "node:path";
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState, saveState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { Resolver } from "../resolve/resolver.js";
import { executePlan } from "../engine/execute.js";
import { runPostApplyHooks } from "../engine/synthetic.js";
import { writeBackup } from "../engine/backup.js";
import { renderPlan } from "../engine/render.js";
import { summarize } from "../engine/types.js";
import { buildPermissionPlan } from "../permissions/plan.js";
import { loadHostCatalog } from "../permissions/catalog-store.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { applyPermissionPlan } from "../permissions/apply.js";
import { confirm, confirmEnv } from "../ui/prompt.js";
import { resolveWithEnv } from "../util/resolve.js";
import { info, warn, success, error } from "../ui.js";

interface ApplyOptions {
  config?: string;
  state?: string;
  env?: string;
  confirmEnv?: string;
  backupDir?: string;
  autoApprove?: boolean;
  refresh?: boolean;
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
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--confirm-env <name>", "confirm a protected env non-interactively (must match --env exactly)")
    .option("--backup-dir <path>", "directory for the pre-apply backup (or set CT_BACKUP_DIR)")
    .option("-y, --auto-approve", "skip the confirmation prompt")
    .option(
      "--refresh",
      "after a successful apply, POST /dynamicgroups/{id}/refresh for each changed dynamic group (per-group only)",
    )
    .action(async (opts: ApplyOptions) => {
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const statePath = cmdEnv.statePath;
      const { resources: desired, permissions, configDir } = await loadConfig(configPath);
      const state = await loadState(statePath, config.host);
      // A per-instance permission catalog this repo committed for THIS host wins over the bundled
      // one (#105) — same precedence as `ct plan`, so the two never disagree about what a right is.
      const hostCatalog = await loadHostCatalog(config.host);
      if (hostCatalog) info(`permission catalog: ${hostCatalog}`);

      const { client } = await authedSession();
      // One shared resolver (#20) across both concurrent plans — see commands/plan.ts.
      const resolver = new Resolver({ client, state, desired, host: config.host });
      // Independent fetches: the resource plan and the permission plan (whose instance-wide
      // /permissions/<domainType> reads are slow) run concurrently rather than back-to-back.
      const [
        { plan, actual, fetchErrors },
        { items: permItems, fetchErrors: permFetchErrors, warnings: permWarnings },
      ] = await Promise.all([
        buildPlan(client, state, desired, { configDir, resolver }),
        buildPermissionPlan(client, state, permissions, desired, resolver, client.version ?? undefined),
      ]);

      // Permission catalog warnings (#25): stale-version / unknown-authId (untouched, never revoked).
      for (const w of permWarnings) warn(w);

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
      const permChangeCount = permItems.reduce((n, i) => n + i.diff.toPut.length + i.diff.toDelete.length, 0);
      const changeCount = s.create + s.update + permChangeCount;
      if (changeCount === 0) {
        success("No changes to apply.");
        return;
      }

      // Protected env (#22): typed confirmation of the env name is MANDATORY — --auto-approve does not
      // bypass it. --confirm-env <name> substitutes for the typed input in CI. Otherwise the normal
      // y/N (skippable with --auto-approve) applies.
      const ok = cmdEnv.protected
        ? await confirmEnv(cmdEnv.name!, { confirmFlag: opts.confirmEnv })
        : await confirm(`Apply ${changeCount} change(s)?`, { assumeYes: opts.autoApprove });
      if (!ok) {
        warn(
          cmdEnv.protected
            ? `Aborted — protected environment "${cmdEnv.name}" was not confirmed (no changes made).`
            : "Aborted — no changes made.",
        );
        process.exitCode = 1;
        return;
      }

      const backupPath = await writeBackup(resolveBackupDir(opts.backupDir, statePath), config.host, actual);
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
      if (permResult.failed.length > 0) {
        // Mirror executePlan's resumable stance: report which tuples failed (not a raw stack) and
        // exit non-zero. Grants are reconciled statelessly, so a plain re-run resumes idempotently.
        error(
          `${permResult.failed.length} permission write(s) failed — re-run to resume (grant reconciliation is idempotent):`,
        );
        for (const f of permResult.failed) {
          info(
            `    ${f.method} ${f.path} (authId ${f.authId}${f.dataId.length ? ` dataId ${f.dataId.join(",")}` : ""}): ${f.message}`,
          );
        }
        process.exitCode = 1;
        return;
      }

      if (opts.refresh) {
        await runPostApplyHooks(plan, state, client);
      } else {
        // The auto-group model is the single most surprising thing about a green apply (#105): the
        // ruleset is written and activated, but ChurchTools computes membership on its own schedule,
        // so a freshly created auto-group is legitimately EMPTY right now. Saying so costs one line
        // and removes the "did it work?" that otherwise follows every first apply.
        const dynamicKeys = plan.items
          .filter(
            (i) =>
              i.action !== "no-op" && i.action !== "delete" && i.changes.some((c) => c.field === "dynamic"),
          )
          .map((i) => i.key);
        if (dynamicKeys.length > 0) {
          info(
            `${dynamicKeys.length} dynamic group(s) written and activated — ChurchTools materializes their ` +
              `membership on its own schedule, so they may be empty for now. Force it with ` +
              `\`ct refresh --group ${dynamicKeys[0]}\` (or re-run apply with --refresh).`,
          );
        }
      }
    });
}
