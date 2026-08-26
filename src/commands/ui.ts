import { spawn } from "node:child_process";
import { Command, InvalidArgumentError } from "commander";
import { startCommanderUiServer } from "../commander-ui/server.js";
import { info, warn } from "../ui.js";

interface UiOptions {
  env?: string;
  port: number;
  open: boolean;
}

function portNumber(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  }
  return value;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { bin: "open", args: [url] }
      : process.platform === "win32"
        ? { bin: "cmd", args: ["/c", "start", "", url] }
        : { bin: "xdg-open", args: [url] };
  const child = spawn(command.bin, command.args, { detached: true, stdio: "ignore" });
  child.on("error", () => warn("Could not open the browser automatically; use the printed URL."));
  child.unref();
}

export function commanderUiCommand(programFactory: () => Command): Command {
  return new Command("ui")
    .description("Start the experimental Commander-generated browser workbench on 127.0.0.1")
    .option("-e, --env <name>", "initial environment profile from ct.envs.json")
    .option("--port <port>", "local port; 0 chooses a free port", portNumber, 0)
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: UiOptions) => {
      const started = await startCommanderUiServer({
        programFactory,
        cwd: process.cwd(),
        environment: options.env,
        port: options.port,
      });
      info(`ct ui listening on ${started.origin}`);
      if (options.open) openBrowser(started.bootstrapUrl);
      else info(`Open once to start the local session: ${started.bootstrapUrl}`);
      const close = (): void => {
        started.server.close();
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
}
