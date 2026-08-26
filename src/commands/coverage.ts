import { relative } from "node:path";
import { Command } from "commander";
import { collectCoverage, runCoverage } from "../application/operations/coverage.js";
import { renderCoverage, renderRoleInstances } from "../coverage/report.js";
import { info, out } from "../ui.js";

interface CoverageOptions {
  state?: string;
  env?: string;
  json?: boolean;
  type?: string;
  declarable?: boolean;
  blocked?: boolean;
}

// Compatibility export for programmatic callers; orchestration now lives in the application layer.
export { collectCoverage };

export function coverageCommand(): Command {
  return new Command("coverage")
    .description("Report what ChurchTools has that the config does not manage, and what is declarable")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--json", "emit the full report as JSON (for CI gates)")
    .option("--type <nameOrKey>", "restrict the role-instance detail to one group type")
    .option("--declarable", "list only role instances whose grants could be adopted today")
    .option("--blocked", "list only role instances blocked by an undeclarable scope dimension")
    .action(async (opts: CoverageOptions) => {
      const result = await runCoverage({
        statePath: opts.state,
        environment: opts.env,
        type: opts.type,
        declarable: opts.declarable,
        blocked: opts.blocked,
      });
      const { project, value } = result;
      if (value.permissionCatalogPath) {
        info(`permission catalog: ${relative(project.cwd, value.permissionCatalogPath)}`);
      }
      if (opts.json) {
        out(value.report);
        return;
      }

      if (project.environment) {
        info(`env: ${project.environment} · host: ${project.host} · state: ${project.stateDisplayPath}`);
      }
      process.stdout.write(`${renderCoverage(value.report)}\n`);
      if (opts.type || opts.declarable || opts.blocked) {
        process.stdout.write(
          value.report.roleInstances.length > 0
            ? `\n${renderRoleInstances(value.report.roleInstances)}\n`
            : "\nNo role instances match.\n",
        );
      }
    });
}
