import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CtApplicationError } from "../application/errors.js";
import type { PlanRequest } from "../application/operations/plan.js";
import { createServerOperationCatalog, type ServerOperationCatalog } from "./operations.js";
import { OperationEventStore } from "./operation-store.js";
import { registerOperationRoutes, ServerInputError } from "./routes.js";
import { SESSION_COOKIE, type LocalServerSession } from "./session.js";
import { bootstrapScript, placeholderHtml } from "./static.js";

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; " +
    "style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

export interface CreateServerAppOptions {
  origin: string | (() => string);
  session: LocalServerSession;
  project?: PlanRequest;
  operations?: ServerOperationCatalog;
  events?: OperationEventStore;
  webRoot?: string;
}

/** Local-only HTTP projection. Handlers call operations; they never access CT/state primitives. */
export function createServerApp(options: CreateServerAppOptions): Hono {
  const app = new Hono();
  const expectedOrigin = (): string =>
    typeof options.origin === "function" ? options.origin() : options.origin;
  const events = options.events ?? new OperationEventStore();
  const operations = options.operations ?? createServerOperationCatalog({ events });
  const project = options.project ?? {};
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const adjacentWebRoot = join(moduleDir, "web");
  const webRoot =
    options.webRoot ??
    (existsSync(adjacentWebRoot) ? adjacentWebRoot : join(moduleDir, "..", "..", "dist", "web"));

  app.use("*", async (context, next) => {
    await next();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) context.header(name, value);
  });

  app.use("/api/*", async (context, next) => {
    const path = context.req.path;
    if (path === "/api/health" || path === "/api/session/bootstrap") return next();
    if (!options.session.accepts(getCookie(context, SESSION_COOKIE))) {
      return context.json({ error: { code: "AUTH_REQUIRED", message: "Local UI session required." } }, 401);
    }
    return next();
  });

  app.use("/api/*", async (context, next) => {
    const eventStream = /\/api\/operations\/[^/]+\/events$/.test(context.req.path);
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method) && !eventStream) return next();
    const requestOrigin = context.req.header("origin");
    // Browsers commonly omit Origin on a same-origin EventSource GET. Its strict SameSite session
    // cookie and the same-origin response boundary still authenticate the stream; an Origin header,
    // when present, must remain an exact match so a foreign page cannot subscribe with credentials.
    if (eventStream && requestOrigin === undefined) return next();
    if (requestOrigin !== expectedOrigin()) {
      return context.json({ error: { code: "ORIGIN_REJECTED", message: "Request origin rejected." } }, 403);
    }
    return next();
  });

  if (existsSync(webRoot)) {
    app.use("/assets/*", serveStatic({ root: webRoot }));
    app.get("/", serveStatic({ root: webRoot, path: "index.html" }));
  }
  app.get("/", (context) => context.html(placeholderHtml));
  app.get("/bootstrap.js", (context) =>
    context.body(bootstrapScript, 200, { "content-type": "text/javascript" }),
  );
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.get("/api/session", (context) =>
    context.json({ authenticated: options.session.accepts(getCookie(context, SESSION_COOKIE)) }),
  );
  app.post("/api/session/bootstrap", async (context) => {
    const body: { secret?: unknown } = await context.req.json<{ secret?: unknown }>().catch(() => ({}));
    const value = typeof body.secret === "string" ? options.session.exchange(body.secret) : null;
    if (!value) {
      return context.json({ error: { code: "BOOTSTRAP_REJECTED", message: "Bootstrap rejected." } }, 401);
    }
    setCookie(context, SESSION_COOKIE, value, {
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
      secure: false,
    });
    return context.json({ authenticated: true });
  });
  registerOperationRoutes(app, operations, project, events);

  app.onError((caught, context) => {
    if (caught instanceof ServerInputError) {
      return context.json({ error: { code: "INVALID_REQUEST", message: caught.message } }, 400);
    }
    if (caught instanceof CtApplicationError) {
      const status =
        caught.code === "AUTH_REQUIRED"
          ? 401
          : caught.code === "OPERATION_EXPIRED"
            ? 410
            : caught.code === "MUTATION_BUSY" || caught.code === "OPERATION_ALREADY_USED"
              ? 409
              : 400;
      return context.json({ error: caught.toJSON() }, status);
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return context.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  return app;
}
