import type { Hono } from "hono";
import type { ConfirmationProof } from "../application/operations/apply.js";
import type { PlanRequest } from "../application/operations/plan.js";
import type { ServerOperationCatalog } from "./operations.js";

export class ServerInputError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

async function bodyOf(context: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown>> {
  return record(await context.req.json().catch(() => ({})));
}

function projectRequest(base: PlanRequest, body: Record<string, unknown>): PlanRequest {
  return {
    ...base,
    // The browser may select an environment, but it cannot escape the server's cwd/config/state scope.
    ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
  };
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new ServerInputError(`${name} must be an array of strings.`);
  }
  return value;
}

function confirmationProof(value: unknown): ConfirmationProof | undefined {
  if (value === undefined) return undefined;
  const proof = record(value);
  if (proof.type === "yes") return { type: "yes" };
  if (proof.type === "environment" && typeof proof.value === "string") {
    return { type: "environment", value: proof.value };
  }
  throw new ServerInputError("proof must be {type:'yes'} or {type:'environment', value:<name>}.");
}

/** Register thin operation routes. No route imports a ChurchTools client, engine or state writer. */
export function registerOperationRoutes(
  app: Hono,
  operations: ServerOperationCatalog,
  baseProject: PlanRequest,
): void {
  app.post("/api/auth/status", async (context) => {
    const body = await bodyOf(context);
    return context.json(await operations.authStatus(projectRequest(baseProject, body)));
  });
  app.post("/api/plan", async (context) => {
    const body = await bodyOf(context);
    return context.json(await operations.plan(projectRequest(baseProject, body)));
  });
  app.post("/api/apply/prepare", async (context) => {
    const body = await bodyOf(context);
    return context.json(
      await operations.prepareApply({
        ...projectRequest(baseProject, body),
        refresh: body.refresh === true,
      }),
    );
  });
  app.post("/api/apply/:id/execute", async (context) => {
    const body = await bodyOf(context);
    return context.json(
      await operations.executeApply(context.req.param("id"), confirmationProof(body.proof)),
    );
  });
  app.post("/api/destroy/prepare", async (context) => {
    const body = await bodyOf(context);
    return context.json(
      await operations.prepareDestroy({
        ...projectRequest(baseProject, body),
        targets: stringList(body.targets, "targets"),
        memberFields: stringList(body.memberFields, "memberFields"),
      }),
    );
  });
  app.post("/api/destroy/:id/execute", async (context) => {
    const body = await bodyOf(context);
    return context.json(
      await operations.executeDestroy(context.req.param("id"), confirmationProof(body.proof)),
    );
  });
}
