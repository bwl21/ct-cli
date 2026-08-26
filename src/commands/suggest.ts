import { Command } from "commander";
import { runCli } from "../runtime/cli-launcher.js";
import { suggestFromContext } from "../suggestions/service.js";

interface SuggestOptions {
  env?: string;
}

export function suggestCommand(): Command {
  return new Command("suggest")
    .description("Return Commander-derived suggestions for a partial ct command as JSON")
    .argument("<context>", "partial command line, with or without the leading ct")
    .option("-e, --env <name>", "environment used by live suggestion sources")
    .action(async (context: string, options: SuggestOptions, command: Command) => {
      const result = await suggestFromContext(command.parent ?? command, context, options.env, {
        cwd: process.cwd(),
        runner: runCli,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    });
}
