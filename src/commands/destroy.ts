import { Command } from "commander";
import { CtApplicationError } from "../application/errors.js";
import {
  executePreparedDestroy,
  prepareDestroy,
  type DestroyRequest,
} from "../application/operations/destroy.js";
import type { ConfirmationProof } from "../application/operations/apply.js";
import { confirmEnv, confirmTyped } from "../ui/prompt.js";
import { error, info, success, warn } from "../ui.js";

export {
  destroyWarnings,
  orderDestroy,
  parseTargets,
  resolveMemberFieldTargets,
  runDeleteLoop,
  runMemberFieldDeleteLoop,
} from "../application/operations/destroy.js";

interface DestroyOptions {
  target?: string[];
  memberField?: string[];
  state?: string;
  env?: string;
  confirmEnv?: string;
  backupDir?: string;
  force?: boolean;
}

export function destroyCommand(): Command {
  return new Command("destroy")
    .description("Explicitly delete managed resources (protected; never implicit)")
    .option("--target <keys...>", "logical key(s) to destroy (repeatable or comma-separated)")
    .option(
      "--member-field <identities...>",
      "group member field(s) to destroy, by portable identity <groupKey>::<fieldKey> (#135) — the " +
        "ONLY way one is ever deleted; apply never removes a field that vanished from config",
    )
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--confirm-env <name>", "confirm a protected env non-interactively (must match --env exactly)")
    .option("--backup-dir <path>", "directory for the pre-destroy backup (or set CT_BACKUP_DIR)")
    .option(
      "--force",
      "skip the typed confirmation (preventDestroy — and a type-level destroy warning, e.g. person-status — is still enforced)",
    )
    .action(async (opts: DestroyOptions) => {
      const request: DestroyRequest = {
        targets: opts.target,
        memberFields: opts.memberField,
        statePath: opts.state,
        environment: opts.env,
        backupDir: opts.backupDir,
      };
      let prepared;
      try {
        prepared = await prepareDestroy(request);
      } catch (caught) {
        if (caught instanceof CtApplicationError && caught.code === "DESTROY_BACKUP_FAILED") {
          error(caught.message);
          process.exitCode = 1;
          return;
        }
        throw caught;
      }

      info(`Backup written: ${prepared.backupPath}`);
      warn(`About to DELETE: ${[...prepared.targets, ...prepared.memberFields].join(", ")}`);
      for (const warning of prepared.warnings) warn(warning.message);
      const risky = prepared.warnings.some((warning) => warning.code === "DESTROY_RISK");
      if (risky && opts.force) {
        warn("--force does NOT skip confirmation for the target(s) above. Confirm interactively.");
      }

      let proof: ConfirmationProof | undefined;
      let confirmed = false;
      if (prepared.confirmation.type === "environment") {
        confirmed = await confirmEnv(prepared.confirmation.environment, { confirmFlag: opts.confirmEnv });
        if (confirmed) proof = { type: "environment", value: prepared.confirmation.environment };
      } else {
        confirmed = await confirmTyped(prepared.confirmation.expected!, {
          force: opts.force && !risky,
        });
        if (confirmed) proof = { type: "yes" };
      }
      if (!confirmed) {
        warn(
          prepared.confirmation.type === "environment"
            ? `Aborted — protected environment "${prepared.confirmation.environment}" was not confirmed. Nothing deleted.`
            : "Aborted — nothing deleted.",
        );
        process.exitCode = 1;
        return;
      }

      const result = await executePreparedDestroy(prepared, proof);
      for (const outcome of result.value.outcomes) {
        if (outcome.status === "destroyed" || outcome.status === "already-absent") {
          success(outcome.message);
        } else {
          error(outcome.message);
        }
      }
      if (!result.value.complete) process.exitCode = 1;
    });
}
