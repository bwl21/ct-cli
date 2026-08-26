import { afterEach, describe, expect, it, vi } from "vitest";
import { startCommanderUiServer, type StartedCommanderUiServer } from "../src/commander-ui/server.js";
import { buildProgram } from "../src/index.js";

let started: StartedCommanderUiServer | undefined;

afterEach(async () => {
  if (!started) return;
  await new Promise<void>((resolve) => started!.server.close(() => resolve()));
  started = undefined;
});

async function session(): Promise<{ origin: string; cookie: string }> {
  const bootstrap = new URL(started!.bootstrapUrl);
  const secret = new URLSearchParams(bootstrap.hash.slice(1)).get("bootstrap");
  const response = await fetch(`${started!.origin}/api/session/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: started!.origin },
    body: JSON.stringify({ secret }),
  });
  expect(response.status).toBe(200);
  return { origin: started!.origin, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

describe("Commander-generated UI server", () => {
  it("protects the schema behind a one-time local bootstrap", async () => {
    started = await startCommanderUiServer({
      programFactory: buildProgram,
      cwd: process.cwd(),
      port: 0,
      runner: vi.fn(),
    });
    expect((await fetch(`${started.origin}/api/schema`)).status).toBe(401);
    const auth = await session();
    const response = await fetch(`${auth.origin}/api/schema`, { headers: { cookie: auth.cookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { commands: Array<{ title: string }> };
    expect(body.commands.map((command) => command.title)).toContain("report permissions");

    const bootstrap = new URL(started.bootstrapUrl);
    const reused = await fetch(`${started.origin}/api/session/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: started.origin },
      body: JSON.stringify({
        secret: new URLSearchParams(bootstrap.hash.slice(1)).get("bootstrap"),
      }),
    });
    expect(reused.status).toBe(403);
  });

  it("runs only reconstructed allowed commands and returns report paths", async () => {
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: "done\n",
      stderr: "",
      truncated: false,
    }));
    started = await startCommanderUiServer({
      programFactory: buildProgram,
      cwd: "/process",
      port: 0,
      runner,
    });
    const auth = await session();
    const response = await fetch(`${auth.origin}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: auth.origin, cookie: auth.cookie },
      body: JSON.stringify({
        command: ["report", "permissions"],
        options: { byBoth: "reports/permissions.md", env: "test" },
      }),
    });
    expect(response.status).toBe(200);
    expect(runner).toHaveBeenCalledWith(
      ["report", "permissions", "--by-both", "reports/permissions.md", "--env", "test"],
      { cwd: "/process" },
    );
    await expect(response.json()).resolves.toMatchObject({
      exitCode: 0,
      reportOutputs: ["reports/permissions.md"],
    });

    const rejected = await fetch(`${auth.origin}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: auth.origin, cookie: auth.cookie },
      body: JSON.stringify({ command: ["apply"] }),
    });
    expect(rejected.status).toBe(400);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("rejects cross-origin execution and unconfirmed state writes", async () => {
    const runner = vi.fn();
    started = await startCommanderUiServer({
      programFactory: buildProgram,
      cwd: "/process",
      port: 0,
      runner,
    });
    const auth = await session();
    const crossOrigin = await fetch(`${auth.origin}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.invalid", cookie: auth.cookie },
      body: JSON.stringify({ command: ["adopt"], arguments: { type: "group", id: "7" }, confirmed: true }),
    });
    expect(crossOrigin.status).toBe(403);

    const unconfirmed = await fetch(`${auth.origin}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: auth.origin, cookie: auth.cookie },
      body: JSON.stringify({ command: ["adopt"], arguments: { type: "group", id: "7" } }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });
});
