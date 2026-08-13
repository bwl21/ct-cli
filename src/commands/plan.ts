import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { Resolver } from "../resolve/resolver.js";
import { renderPlan } from "../engine/render.js";
import { summarize } from "../engine/types.js";
import { buildPermissionPlan } from "../permissions/plan.js";
import { loadHostCatalog } from "../permissions/catalog-store.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { info, warn, out } from "../ui.js";

interface PlanOptions {
  config?: string;
  state?: string;
  env?: string;
  json?: boolean;
  detailedExitcode?: boolean;
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .option(
      "--detailed-exitcode",
      "Terraform-style exit code: 0 = no changes, 1 = error, 2 = changes pending (resource or permission)",
    )
    .action(async (opts: PlanOptions) => {
      // Resolve the env FIRST — it wires the target host/token into the process env before resolveConfig.
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const { resources: desired, permissions, configDir } = await loadConfig(configPath);
      // loadState already refuses a host mismatch (state.ts) — no second guard needed here.
      const state = await loadState(cmdEnv.statePath, config.host);
      // A per-instance permission catalog this repo committed for THIS host wins over the one bundled
      // with the release (#105). Loaded before the plan is built so every right resolves against it.
      const hostCatalog = await loadHostCatalog(config.host);
      if (hostCatalog) info(`permission catalog: ${hostCatalog}`);

      const { client } = await authedSession();
      // One shared resolver (#20): buildPlan and buildPermissionPlan run concurrently, so a single
      // instance means each master-data catalog is fetched at most once (cache is Promise-keyed).
      const resolver = new Resolver({ client, state, desired, host: config.host });
      // Independent fetches run concurrently (see commands/apply.ts).
      const [{ plan, fetchErrors }, { items: permItems, fetchErrors: permFetchErrors, warnings: permWarnings }] =
        await Promise.all([
          buildPlan(client, state, desired, { configDir, resolver }),
          buildPermissionPlan(client, state, permissions, desired, resolver, client.version ?? undefined),
        ]);
      // "Changes present" for --detailed-exitcode / the JSON summary: anything `ct apply` would
      // actually act on — a resource item whose action isn't a no-op, OR a permission item with a
      // grant/revoke to write. Drift by itself does NOT count: an item can carry `drift` while
      // staying a no-op (the field drifted but isn't managed by config, or coincidentally matches
      // desired again), and apply would write nothing for it — see docs/README "CI usage".
      const hasResourceChanges = plan.items.some((i) => i.action !== "no-op");
      const hasPermissionChanges = permItems.some(
        (i) => i.diff.toPut.length > 0 || i.diff.toDelete.length > 0,
      );
      const hasChanges = hasResourceChanges || hasPermissionChanges;

      if (opts.json) {
        // Additive on top of the raw plan/permissions (#24) — existing consumers of `plan`/`permissions`
        // are unaffected. See README "CI usage" for exactly what each summary field means.
        out({
          plan,
          permissions: permItems,
          summary: {
            resources: summarize(plan),
            drifted: plan.items.filter((i) => i.drift && i.drift.length > 0).length,
            permissions: {
              toPut: permItems.reduce((n, i) => n + i.diff.toPut.length, 0),
              toDelete: permItems.reduce((n, i) => n + i.diff.toDelete.length, 0),
              preserved: permItems.reduce((n, i) => n + i.diff.preserved.length, 0),
            },
            hasChanges,
          },
        });
      } else {
        // Under --env, surface the target env name + its CT version (per-env version gate, #22) so a
        // dev/prod version skew is visible before applying. No --env keeps the original header byte-identical.
        if (cmdEnv.name) {
          info(
            `env: ${cmdEnv.name} · host: ${config.host} · ChurchTools ${client.version ?? "unknown"} · ` +
              `config: ${configPath} · state host: ${state.host}`,
          );
        } else {
          info(`config: ${configPath} · state host: ${state.host}`);
        }
        process.stdout.write(`${renderPlan(plan)}\n`);
        if (permItems.length > 0) {
          process.stdout.write(`\n${renderPermissionPlan(permItems)}\n`);
        }
      }

      // Permission catalog warnings (#25): stale-version / unknown-authId. Informational — they do
      // not make the plan incomplete (unlike fetchErrors), so they never set a failing exit code.
      for (const w of permWarnings) warn(w);

      const allFetchErrors = [...fetchErrors, ...permFetchErrors];
      if (allFetchErrors.length > 0) {
        warn(
          `Plan is INCOMPLETE — ${allFetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        // An INCOMPLETE plan is always an error (1) — even under --detailed-exitcode, and even if
        // the (partial) plan has changes. Never demoted to 2: an incomplete diff cannot be trusted
        // enough to report "changes present" instead of "this run failed".
        process.exitCode = 1;
      } else if (opts.detailedExitcode && hasChanges) {
        process.exitCode = 2;
      }
    });
}
