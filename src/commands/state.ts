import { Command } from "commander";
import { listState, rekeyStateEntry, removeStateEntry } from "../application/operations/state.js";
import { info, out, success, warn } from "../ui.js";

interface StateOptions {
  state?: string;
  env?: string;
  managed?: boolean;
  external?: boolean;
}

interface StateRmOptions extends StateOptions {
  config?: string;
  force?: boolean;
  dryRun?: boolean;
}

export function stateCommand(): Command {
  const cmd = new Command("state").description("Inspect managed and external ct-cli resource state");

  cmd
    .command("list")
    .description("List managed and external entries together (JSON to stdout)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--managed", "show managed entries only")
    .option("--external", "show external entries only")
    .action(async (opts: StateOptions) => {
      const result = await listState({
        statePath: opts.state,
        environment: opts.env,
        managed: opts.managed,
        external: opts.external,
      });
      info(
        `${result.value.entries.length} state entr${result.value.entries.length === 1 ? "y" : "ies"} in ${result.project.stateDisplayPath} (host ${result.project.host}).`,
      );
      out(result.value.entries.map(({ kind, ownership, entry }) => ({ kind, ownership, ...entry })));
    });

  cmd
    .command("rm")
    .description("Remove a managed or external entry from state. Never touches ChurchTools.")
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
        info(
          `Would remove ${result.value.kind} ${entry.type}.${key} (#${entry.id}) from ${result.project.stateDisplayPath}.`,
        );
        return;
      }
      success(
        `Removed ${result.value.kind} ${entry.type}.${key} (#${entry.id}) from ${result.project.stateDisplayPath}.`,
      );
      info(
        `ChurchTools was not contacted — #${entry.id} still exists there. ` +
          (result.value.kind === "managed"
            ? `Re-adopt it with \`ct adopt ${type} ${entry.id}\`.`
            : `Re-bind it with \`ct use ${type} ${entry.id} --key ${key}\`.`),
      );
    });

  cmd
    .command("rekey")
    .description("Change the logical key of a managed or external state entry")
    .argument("<type>", "resource type")
    .argument("<old-key>", "current logical key")
    .argument("<new-key>", "new globally unique logical key")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--dry-run", "report the rekey without writing")
    .action(
      async (type: string, oldKey: string, newKey: string, opts: StateOptions & { dryRun?: boolean }) => {
        const result = await rekeyStateEntry({
          type,
          oldKey,
          newKey,
          statePath: opts.state,
          environment: opts.env,
          dryRun: opts.dryRun,
        });
        for (const warning of result.warnings) warn(warning.message);
        if (opts.dryRun) {
          info(`Would rekey ${result.value.kind} ${type}.${oldKey} to ${type}.${newKey}.`);
        } else if (!result.value.changed) {
          info(`${result.value.kind} ${type}.${oldKey} already has that key; state is unchanged.`);
        } else {
          success(`Rekeyed ${result.value.kind} ${type}.${oldKey} to ${type}.${newKey}.`);
        }
        info("ChurchTools was not contacted.");
      },
    );

  return cmd;
}
