import { Command } from "commander";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import { loadState } from "../state/state.js";
import { info, out } from "../ui.js";

interface StateOptions {
  state?: string;
  env?: string;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect the managed-resource state file");

  cmd
    .command("list")
    .description("List every resource under management (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .action(async (opts: StateOptions) => {
      const cmdEnv = await prepareEnv(opts);
      const statePath = cmdEnv.statePath;
      const state = await loadState(statePath, (await resolveConfig()).host);
      const resources = Object.values(state.resources);
      info(`${resources.length} managed resource(s) in ${statePath} (host ${state.host}).`);
      out(resources);
    });

  return cmd;
}
