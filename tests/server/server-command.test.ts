import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startCtServer } from "../../src/commands/server.js";

let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    }),
);

describe("ct server", () => {
  it("binds to loopback on a free port and serves health", async () => {
    const started = await startCtServer({ port: 0 });
    server = started.server;
    expect(started.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(started.bootstrapUrl).toContain(`${started.origin}/#bootstrap=`);

    const response = await fetch(`${started.origin}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
