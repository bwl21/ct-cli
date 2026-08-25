import { Command } from "commander";
import { runAdoptResource } from "../application/operations/adopt.js";
import { success, info, warn, out } from "../ui.js";
import { adoptGrantsCommand } from "./adopt-grants.js";
import { adoptGroupCommand } from "./adopt-group.js";

interface AdoptOptions {
  key?: string;
  state?: string;
  env?: string;
  /** Opt in to changing an already-managed resource's logical key (#123). Never the default. */
  rekey?: boolean;
  dryRun?: boolean;
}

export function adoptCommand(): Command {
  const cmd = new Command("adopt")
    .description("Put one existing ChurchTools resource under management (adds it to the state file)")
    .argument("<type>", "resource type, e.g. campus | group | group-type")
    .argument("<id>", "ChurchTools id of the resource")
    .option("-k, --key <key>", "logical key (defaults to a slug of the resource name)")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option(
      "--rekey",
      "let a re-adoption change an already-managed resource's logical key to the derived one (#123)",
    )
    .option("--dry-run", "preview the config entry and state change without writing")
    .action(async (type: string, rawId: string, opts: AdoptOptions) => {
      const result = await runAdoptResource({
        type,
        id: rawId,
        key: opts.key,
        statePath: opts.state,
        environment: opts.env,
        rekey: opts.rekey,
        dryRun: opts.dryRun,
      });
      const adopted = result.value;
      for (const warning of result.warnings.filter((item) => item.code === "ADOPT_KEY_PRESERVED")) {
        warn(warning.message);
      }
      if (adopted.dryRun) {
        info(`Would adopt ${type} #${adopted.id} as "${adopted.key}". Generated config entry:`);
        out({
          key: adopted.key,
          type,
          id: adopted.id,
          fields: adopted.fields,
          config: adopted.config,
        });
        return;
      }
      success(
        `${adopted.action === "created" ? "Adopted" : "Updated"} ${type} #${adopted.id} as "${adopted.key}" → ${result.project.stateDisplayPath}`,
      );
      info(`Config entry: ${adopted.config}`);
      for (const warning of result.warnings.filter((item) => item.code !== "ADOPT_KEY_PRESERVED")) {
        warn(warning.message);
      }
    });

  // `ct adopt grants <domainType> <domainId>` — grants are not state-tracked, so this subcommand
  // prints a config block only and never writes state. Commander matches the "grants" subcommand
  // name before falling through to the `<type> <id>` action above.
  cmd.addCommand(adoptGrantsCommand());
  // `ct adopt group ...` — bulk/filtered adoption (--type, --children-of, multiple ids) and
  // --with-dynamic ruleset capture (#51). Named subcommand, so it also handles the plain single-id
  // `ct adopt group <id>` case (Commander matches it before the generic `<type> <id>` action above).
  cmd.addCommand(adoptGroupCommand());
  return cmd;
}
