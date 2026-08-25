import { Command } from "commander";
import { relative } from "node:path";
import { runPlan } from "../application/operations/plan.js";
import { renderPlan } from "../engine/render.js";
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
      const result = await runPlan({
        configPath: opts.config,
        statePath: opts.state,
        environment: opts.env,
      });
      const { project, value } = result;
      const catalogPath = value.permissionCatalogPath
        ? relative(project.cwd, value.permissionCatalogPath)
        : null;
      if (catalogPath) info(`permission catalog: ${catalogPath}`);

      if (opts.json) {
        // Additive on top of the raw plan/permissions (#24) — existing consumers of `plan`/`permissions`
        // are unaffected. See README "CI usage" for exactly what each summary field means.
        out({
          plan: value.plan,
          permissions: value.permissions,
          summary: value.summary,
        });
      } else {
        // Under --env, surface the target env name + its CT version (per-env version gate, #22) so a
        // dev/prod version skew is visible before applying. No --env keeps the original header byte-identical.
        if (project.environment) {
          info(
            `env: ${project.environment} · host: ${project.host} · ChurchTools ${value.churchToolsVersion ?? "unknown"} · ` +
              `config: ${project.configDisplayPath} · state host: ${value.stateHost}`,
          );
        } else {
          info(`config: ${project.configDisplayPath} · state host: ${value.stateHost}`);
        }
        process.stdout.write(`${renderPlan(value.plan)}\n`);
        if (value.permissions.length > 0) {
          process.stdout.write(`\n${renderPermissionPlan(value.permissions)}\n`);
        }
      }

      // Permission catalog warnings (#25): stale-version / unknown-authId. Informational — they do
      // not make the plan incomplete (unlike fetchErrors), so they never set a failing exit code.
      for (const warning of result.warnings) warn(warning.message);

      if (!value.complete) {
        warn(
          `Plan is INCOMPLETE — ${value.fetchErrors.length} resource(s) could not be fetched; their diff is missing. Re-run to retry.`,
        );
        // An INCOMPLETE plan is always an error (1) — even under --detailed-exitcode, and even if
        // the (partial) plan has changes. Never demoted to 2: an incomplete diff cannot be trusted
        // enough to report "changes present" instead of "this run failed".
        process.exitCode = 1;
      } else if (opts.detailedExitcode && value.summary.hasChanges) {
        process.exitCode = 2;
      }
    });
}
