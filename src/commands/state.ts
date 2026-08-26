import { Command } from "commander";
import { listState, removeStateEntry } from "../application/operations/state.js";
import { info, out, success, warn } from "../ui.js";

interface StateOptions {
  state?: string;
  env?: string;
}

interface StateRmOptions extends StateOptions {
  config?: string;
  force?: boolean;
  dryRun?: boolean;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect the managed-resource state file");

  cmd
    .command("list")
    .description("List every resource under management (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .action(async (opts: StateOptions) => {
      const result = await listState({ statePath: opts.state, environment: opts.env });
      info(
        `${result.value.resources.length} managed resource(s) in ${result.project.stateDisplayPath} (host ${result.project.host}).`,
      );
      out(result.value.resources);
    });

  cmd
    .command("rm")
    .description("Un-adopt: remove a resource from the state file. Never touches ChurchTools.")
    .argument("<type>", "resource type, e.g. campus | group | group-role")
    .argument("<key>", "logical key of the entry to remove")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("-c, --config <path>", "config file to check the key against (or set CT_CONFIG)")
    .option("--force", "remove even though the key is still declared in the config")
    .option("--dry-run", "report what would be removed without writing")
    .action(async (type: string, key: string, opts: StateRmOptions) => {
      const result = await removeStateEntry({
        type,
        key,
        statePath: opts.state,
        environment: opts.env,
        configPath: opts.config,
        force: opts.force,
        dryRun: opts.dryRun,
      });
      for (const warning of result.warnings) warn(warning.message);
      const entry = result.value.entry;
      if (!result.value.removed) {
        info(`Would remove ${entry.type}.${key} (#${entry.id}) from ${result.project.stateDisplayPath}.`);
        return;
      }
      success(`Removed ${entry.type}.${key} (#${entry.id}) from ${result.project.stateDisplayPath}.`);
      info(
        `ChurchTools was not contacted — #${entry.id} still exists there, now unmanaged. ` +
          `Re-adopt it with \`ct adopt ${type} ${entry.id}\`.`,
      );
    });

  return cmd;
}
