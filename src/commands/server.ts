import { spawn } from "node:child_process";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { Command, InvalidArgumentError } from "commander";
import { createServerApp } from "../server/app.js";
import { LocalServerSession } from "../server/session.js";
import { info, warn } from "../ui.js";

interface ServerOptions {
  env?: string;
  config?: string;
  state?: string;
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

export interface StartedCtServer {
  server: Server;
  origin: string;
  bootstrapUrl: string;
}

export async function startCtServer(options: Omit<ServerOptions, "open">): Promise<StartedCtServer> {
  const session = new LocalServerSession();
  let origin = "";
  const app = createServerApp({
    origin: () => origin,
    session,
    project: {
      environment: options.env,
      configPath: options.config,
      statePath: options.state,
    },
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const instance = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port }, (address) => {
      origin = `http://127.0.0.1:${address.port}`;
      resolve(instance as Server);
    });
    instance.once("error", reject);
  });
  return {
    server,
    origin,
    bootstrapUrl: `${origin}/#bootstrap=${encodeURIComponent(session.bootstrapSecret)}`,
  };
}

export function serverCommand(): Command {
  return new Command("server")
    .description("Start the local ct browser UI on 127.0.0.1")
    .option("-e, --env <name>", "initial environment profile from ct.envs.json")
    .option("-c, --config <path>", "config file (or set CT_CONFIG)")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("--port <port>", "local port; 0 chooses a free port", portNumber, 0)
    .option("--no-open", "do not open the browser automatically")
    .action(async (options: ServerOptions) => {
      const started = await startCtServer(options);
      info(`ct server listening on ${started.origin}`);
      if (options.open) {
        openBrowser(started.bootstrapUrl);
      } else {
        info(`Open once to start the local session: ${started.bootstrapUrl}`);
      }
      const close = (): void => {
        started.server.close();
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
}
