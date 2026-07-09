import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState } from "../state/state.js";
import { loadConfig, resolveConfigPath } from "../config/load.js";
import { buildPlan } from "../engine/build.js";
import { Resolver } from "../resolve/resolver.js";
import { renderPlan } from "../engine/render.js";
import { buildPermissionPlan } from "../permissions/plan.js";
import { renderPermissionPlan } from "../permissions/render.js";
import { info, warn, out } from "../ui.js";

interface PlanOptions {
  config?: string;
  state?: string;
  env?: string;
  json?: boolean;
}

export function planCommand(): Command {
  return new Command("plan")
    .description("Show the diff between the desired-state config and ChurchTools (read-only)")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--json", "emit the raw plan as JSON instead of the rendered diff")
    .action(async (opts: PlanOptions) => {
      // Resolve the env FIRST — it wires the target host/token into the process env before resolveConfig.
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const configPath = resolveConfigPath(opts.config);
      const { resources: desired, permissions, configDir } = await loadConfig(configPath);
      // loadState already refuses a host mismatch (state.ts) — no second guard needed here.
      const state = await loadState(cmdEnv.statePath, config.host);

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
      if (opts.json) {
        out({ plan, permissions: permItems });
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
        process.exitCode = 1;
      }
    });
}
