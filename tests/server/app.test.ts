import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerApp } from "../../src/server/app.js";
import type { ServerOperationCatalog } from "../../src/server/operations.js";
import { OperationEventStore } from "../../src/server/operation-store.js";
import { LocalServerSession } from "../../src/server/session.js";

const origin = "http://127.0.0.1:8765";

function harness(webRoot?: string) {
  const session = new LocalServerSession({ bootstrapSecret: "bootstrap", sessionSecret: "session" });
  const plan = vi.fn(async (request) => ({ operation: "plan", request }));
  const coverage = vi.fn(async (request) => ({ operation: "coverage", request }));
  const state = vi.fn(async (request) => ({ operation: "state", request }));
  const authStatus = vi.fn(async (request) => ({ operation: "auth", request }));
  const prepareApply = vi.fn(async (request) => ({ id: "apply-1", request }));
  const executeApply = vi.fn(async (id, proof) => ({ operation: "apply", id, proof }));
  const prepareDestroy = vi.fn(async (request) => ({ id: "destroy-1", request }));
  const executeDestroy = vi.fn(async (id, proof) => ({ operation: "destroy", id, proof }));
  const events = new OperationEventStore();
  const app = createServerApp({
    origin,
    session,
    project: {
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "dev",
    },
    operations: {
      plan,
      coverage,
      state,
      authStatus,
      prepareApply,
      executeApply,
      prepareDestroy,
      executeDestroy,
    } as unknown as ServerOperationCatalog,
    events,
    webRoot,
  });
  return {
    app,
    plan,
    coverage,
    state,
    authStatus,
    prepareApply,
    executeApply,
    prepareDestroy,
    executeDestroy,
    events,
  };
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
  it("serves a built web entry and its hashed asset", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "ct-web-"));
    try {
      await mkdir(join(webRoot, "assets"));
      await writeFile(
        join(webRoot, "index.html"),
        '<!doctype html><div id="app"></div><script type="module" src="/assets/app-123.js"></script>',
      );
      await writeFile(join(webRoot, "assets/app-123.js"), "export const ready = true;");
      const { app } = harness(webRoot);

      const root = await app.request("/");
      expect(root.status).toBe(200);
      expect(await root.text()).toContain('id="app"');
      const asset = await app.request("/assets/app-123.js");
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("javascript");
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });

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

  it("projects prepared apply and destroy without exposing server-owned paths", async () => {
    const { app, prepareApply, executeApply, prepareDestroy, executeDestroy } = harness();
    const cookie = await bootstrap(app);
    const headers = { origin, cookie, "content-type": "application/json" };

    const apply = await app.request("/api/apply/prepare", {
      method: "POST",
      headers,
      body: JSON.stringify({ environment: "prod", refresh: true, statePath: "/escape.json" }),
    });
    expect(apply.status).toBe(200);
    expect(prepareApply).toHaveBeenCalledWith({
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "prod",
      refresh: true,
    });
    const applied = await app.request("/api/apply/apply-1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ proof: { type: "environment", value: "prod" } }),
    });
    expect(applied.status).toBe(200);
    expect(executeApply).toHaveBeenCalledWith("apply-1", { type: "environment", value: "prod" });

    const destroy = await app.request("/api/destroy/prepare", {
      method: "POST",
      headers,
      body: JSON.stringify({ targets: ["area"], memberFields: ["area::wahl"] }),
    });
    expect(destroy.status).toBe(200);
    expect(prepareDestroy).toHaveBeenCalledWith({
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "dev",
      targets: ["area"],
      memberFields: ["area::wahl"],
    });
    const destroyed = await app.request("/api/destroy/destroy-1/execute", {
      method: "POST",
      headers,
      body: JSON.stringify({ proof: { type: "yes" } }),
    });
    expect(destroyed.status).toBe(200);
    expect(executeDestroy).toHaveBeenCalledWith("destroy-1", { type: "yes" });
  });

  it("projects coverage and state reads with validated filters and server-owned project paths", async () => {
    const { app, coverage, state } = harness();
    const cookie = await bootstrap(app);
    const headers = { origin, cookie, "content-type": "application/json" };

    const coverageResponse = await app.request("/api/coverage", {
      method: "POST",
      headers,
      body: JSON.stringify({
        environment: "prod",
        type: "team",
        declarable: true,
        blocked: false,
        statePath: "/escape.json",
      }),
    });
    expect(coverageResponse.status).toBe(200);
    expect(coverage).toHaveBeenCalledWith({
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "prod",
      type: "team",
      declarable: true,
      blocked: false,
    });

    const stateResponse = await app.request("/api/state", {
      method: "POST",
      headers,
      body: JSON.stringify({ environment: "prod", cwd: "/escape" }),
    });
    expect(stateResponse.status).toBe(200);
    expect(state).toHaveBeenCalledWith({
      cwd: "/project",
      configPath: "fixed.config.ts",
      statePath: "fixed.state.json",
      environment: "prod",
    });
  });

  it("rejects malformed coverage filters before invoking the operation", async () => {
    const { app, coverage } = harness();
    const cookie = await bootstrap(app);
    const response = await app.request("/api/coverage", {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ blocked: "yes" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(coverage).not.toHaveBeenCalled();
  });

  it("rejects malformed destructive targets at the transport boundary", async () => {
    const { app, prepareDestroy } = harness();
    const cookie = await bootstrap(app);
    const response = await app.request("/api/destroy/prepare", {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify({ targets: "area" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(prepareDestroy).not.toHaveBeenCalled();
  });

  it("streams the shared operation events and rejects a foreign event-stream origin", async () => {
    const { app, events } = harness();
    const cookie = await bootstrap(app);
    events.open("run-1");
    events.observer("run-1").emit({ type: "phase-started", phase: "backup" });
    events.complete("run-1", "apply");

    const rejected = await app.request("/api/operations/run-1/events", {
      headers: { cookie, origin: "https://attacker.example" },
    });
    expect(rejected.status).toBe(403);

    const response = await app.request("/api/operations/run-1/events", {
      headers: { cookie, origin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain('data: {"type":"phase-started","phase":"backup"}');
    expect(text).toContain('data: {"type":"operation-completed","operation":"apply"}');
  });
});
