import { describe, expect, it, vi } from "vitest";
import { createServerApp, type ServerOperationCatalog } from "../../src/server/app.js";
import { LocalServerSession } from "../../src/server/session.js";

const origin = "http://127.0.0.1:8765";

function harness() {
  const session = new LocalServerSession({ bootstrapSecret: "bootstrap", sessionSecret: "session" });
  const plan = vi.fn(async (request) => ({ operation: "plan", request }));
  const authStatus = vi.fn(async (request) => ({ operation: "auth", request }));
  const app = createServerApp({
    origin,
    session,
    project: {
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "dev",
    },
    operations: { plan, authStatus } as unknown as ServerOperationCatalog,
  });
  return { app, plan, authStatus };
}

async function bootstrap(app: ReturnType<typeof createServerApp>): Promise<string> {
  const response = await app.request("/api/session/bootstrap", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ secret: "bootstrap" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";", 1)[0]!;
}

describe("local server security boundary", () => {
  it("serves health with restrictive browser headers", async () => {
    const { app } = harness();
    const response = await app.request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("exchanges the fragment secret once for a strict HttpOnly cookie", async () => {
    const { app } = harness();
    const noOrigin = await app.request("/api/session/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "bootstrap" }),
    });
    expect(noOrigin.status).toBe(403);

    const response = await app.request("/api/session/bootstrap", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ secret: "bootstrap" }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("ct_ui_session=session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const reused = await app.request("/api/session/bootstrap", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ secret: "bootstrap" }),
    });
    expect(reused.status).toBe(401);
    expect(await reused.text()).not.toContain("bootstrap");
  });

  it("requires session + exact origin and keeps project paths server-owned", async () => {
    const { app, plan } = harness();
    const unauthenticated = await app.request("/api/plan", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: "{}",
    });
    expect(unauthenticated.status).toBe(401);

    const cookie = await bootstrap(app);
    const crossOrigin = await app.request("/api/plan", {
      method: "POST",
      headers: { origin: "https://attacker.example", cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);

    const response = await app.request("/api/plan", {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({
        environment: "prod",
        cwd: "/escape",
        configPath: "/escape.ts",
        statePath: "/escape.json",
      }),
    });
    expect(response.status).toBe(200);
    expect(plan).toHaveBeenCalledWith({
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "prod",
    });
  });
});
