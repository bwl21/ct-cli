import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { CtApplicationError } from "../application/errors.js";
import { runAuthStatus, type AuthStatusRequest } from "../application/operations/auth.js";
import { runPlan, type PlanRequest } from "../application/operations/plan.js";
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

export interface ServerOperationCatalog {
  authStatus(request: AuthStatusRequest): ReturnType<typeof runAuthStatus>;
  plan(request: PlanRequest): ReturnType<typeof runPlan>;
}

export interface CreateServerAppOptions {
  origin: string | (() => string);
  session: LocalServerSession;
  project?: PlanRequest;
  operations?: ServerOperationCatalog;
}

function mergeProject(base: PlanRequest, body: unknown): PlanRequest {
  const requested = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    ...base,
    // The browser may select an environment, but it cannot escape the server's cwd/config/state scope.
    ...(typeof requested.environment === "string" ? { environment: requested.environment } : {}),
  };
}

/** Local-only HTTP projection. Handlers call operations; they never access CT/state primitives. */
export function createServerApp(options: CreateServerAppOptions): Hono {
  const app = new Hono();
  const expectedOrigin = (): string =>
    typeof options.origin === "function" ? options.origin() : options.origin;
  const operations = options.operations ?? { authStatus: runAuthStatus, plan: runPlan };
  const project = options.project ?? {};

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
    if (["GET", "HEAD", "OPTIONS"].includes(context.req.method)) return next();
    if (context.req.header("origin") !== expectedOrigin()) {
      return context.json({ error: { code: "ORIGIN_REJECTED", message: "Request origin rejected." } }, 403);
    }
    return next();
  });

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
  app.post("/api/auth/status", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return context.json(await operations.authStatus(mergeProject(project, body)));
  });
  app.post("/api/plan", async (context) => {
    const body = await context.req.json().catch(() => ({}));
    return context.json(await operations.plan(mergeProject(project, body)));
  });

  app.onError((caught, context) => {
    if (caught instanceof CtApplicationError) return context.json({ error: caught.toJSON() }, 400);
    const message = caught instanceof Error ? caught.message : String(caught);
    return context.json({ error: { code: "INTERNAL_ERROR", message } }, 500);
  });
  return app;
}
