import { Command } from "commander";
import { runRefresh, selectRefreshTargets } from "../application/operations/refresh.js";
import { error, info, success, warn } from "../ui.js";

interface RefreshOptions {
  state?: string;
  env?: string;
  group?: string;
  all?: boolean;
}

// Compatibility export for callers that previously reused the command helper.
export { selectRefreshTargets };

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
      const result = await runRefresh({
        statePath: opts.state,
        environment: opts.env,
        group: opts.group,
        all: opts.all,
      });
      for (const warning of result.warnings) warn(warning.message);
      if (result.value.outcomes.length === 0) {
        info("No managed dynamic groups to refresh.");
        return;
      }
      for (const outcome of result.value.outcomes) {
        if (outcome.error) {
          error(`Failed to refresh ${outcome.key} (#${outcome.id}): ${outcome.error}`);
          continue;
        }
        success(
          outcome.counts
            ? `refreshed ${outcome.key} (#${outcome.id}): +${outcome.counts.created} ~${outcome.counts.updated} -${outcome.counts.deleted}`
            : `refreshed ${outcome.key} (#${outcome.id})`,
        );
      }
      if (result.value.failed > 0) process.exitCode = 1;
    });
}
