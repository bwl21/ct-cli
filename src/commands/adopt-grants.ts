import { relative } from "node:path";
import { Command } from "commander";
import { runAdoptGrants } from "../application/operations/adopt-grants.js";
import { info, warn } from "../ui.js";

interface AdoptGrantsOptions {
  state?: string;
  env?: string;
  group?: string;
  allDeclarable?: boolean;
  write?: string;
}

export function adoptGrantsCommand(): Command {
  return new Command("grants")
    .description(
      "Print paste-ready grants config block(s) from live permission rows (does not write state). " +
        "One domain, or bulk via --group / --all-declarable.",
    )
    .argument("[domainType]", "group_role | group_type_role | status")
    .argument("[domainId]", "the domainId of the permission domain object")
    .option("-s, --state <path>", "state file path (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json")
    .option("--group <keyOrId>", "bulk: every role instance of this group")
    .option("--all-declarable", "bulk: every declarable role instance on the host")
    .option("--write <path>", "append emitted blocks to this file instead of stdout")
    .action(
      async (
        domainType: string | undefined,
        domainId: string | undefined,
        _localOpts: AdoptGrantsOptions,
        command: Command,
      ) => {
        const opts = command.optsWithGlobals() as AdoptGrantsOptions;
        const result = await runAdoptGrants({
          domainType,
          domainId,
          statePath: opts.state,
          environment: opts.env,
          group: opts.group,
          allDeclarable: opts.allDeclarable,
          write: opts.write,
        });
        if (result.value.permissionCatalogPath) {
          info(`permission catalog: ${relative(result.project.cwd, result.value.permissionCatalogPath)}`);
        }
        if (result.value.summary) info(result.value.summary);
        info(
          `Grants are not state-tracked — this prints config only and does NOT write ${result.project.stateDisplayPath}.`,
        );
        if (result.value.writtenPath) {
          info(
            `Appended ${result.value.blocks.length} block(s) to ${opts.write}. Run \`ct plan\` before applying.`,
          );
        } else {
          info("Paste the block(s) below into your config, then run `ct plan`:");
          process.stdout.write(result.value.text);
        }
        for (const warning of result.warnings) warn(warning.message);
      },
    );
}
