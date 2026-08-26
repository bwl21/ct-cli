import { Command } from "commander";
import { runRefresh, selectRefreshTargets } from "../application/operations/refresh.js";
import { cliObserver } from "./observer.js";
import { info } from "../ui.js";

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
      // The fan-out caution and every per-group line are printed by the observer while the run
      // is still going, not after every membership has already been recomputed (#156 review).
      const result = await runRefresh(
        {
          statePath: opts.state,
          environment: opts.env,
          group: opts.group,
          all: opts.all,
        },
        { observer: cliObserver() },
      );
      if (result.value.outcomes.length === 0) {
        info("No managed dynamic groups to refresh.");
        return;
      }
      if (result.value.failed > 0) process.exitCode = 1;
    });
}
