import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Command } from "commander";
import { completionCandidates } from "../completion/candidates.js";
import { buildUiInvocation, completionWords, UiInputError } from "./invocation.js";
import { runCli, type CliRunResult, type RunCliOptions } from "./launcher.js";
import { COMMANDER_UI_PAGE } from "./page.js";
import { commanderUiSchema, findUiCommand } from "./schema.js";

const BODY_LIMIT = 64 * 1024;
const COOKIE = "ct_ui_session";
const VALUE_DOMAIN_CACHE_MS = 30_000;
const MAX_SUGGESTIONS = 100;

type Runner = (argv: readonly string[], options: RunCliOptions) => Promise<CliRunResult>;

interface ValueSuggestion {
  value: string;
  label: string;
}

export interface StartCommanderUiOptions {
  programFactory: () => Command;
  cwd: string;
  environment?: string;
  port: number;
  runner?: Runner;
}

export interface StartedCommanderUiServer {
  server: Server;
  origin: string;
  bootstrapUrl: string;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > BODY_LIMIT) throw new UiInputError("Request body is too large.");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UiInputError("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function stringPath(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((part) => typeof part !== "string")) {
    throw new UiInputError("command must be an array of strings.");
  }
  return value as string[];
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function suggestionLabel(row: Record<string, unknown>, fields: readonly string[]): string {
  return fields
    .flatMap((field) => {
      const value = row[field];
      if (value === undefined || value === null || value === "") return [];
      return [field === "id" ? `#${String(value)}` : String(value)];
    })
    .join(" · ");
}

export async function startCommanderUiServer(
  options: StartCommanderUiOptions,
): Promise<StartedCommanderUiServer> {
  const program = options.programFactory();
  const schema = commanderUiSchema(program);
  const runner = options.runner ?? runCli;
  const bootstrapSecret = randomBytes(32).toString("base64url");
  const sessionSecret = randomBytes(32).toString("base64url");
  const valueDomainCache = new Map<string, { expires: number; suggestions: ValueSuggestion[] }>();
  let bootstrapAvailable = true;
  let origin = "";

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin || "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        response.end(COMMANDER_UI_PAGE);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/session/bootstrap") {
        if (request.headers.origin !== origin) return json(response, 403, { error: "Invalid origin." });
        const body = await requestBody(request);
        if (
          !bootstrapAvailable ||
          typeof body.secret !== "string" ||
          !sameSecret(body.secret, bootstrapSecret)
        ) {
          return json(response, 403, { error: "Invalid bootstrap secret." });
        }
        bootstrapAvailable = false;
        response.setHeader("set-cookie", `${COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`);
        return json(response, 200, { ok: true });
      }

      if (!sameSecret(cookieValue(request, COOKIE) ?? "", sessionSecret)) {
        return json(response, 401, { error: "Local UI session required." });
      }
      if (request.method === "POST" && request.headers.origin !== origin) {
        return json(response, 403, { error: "Invalid origin." });
      }

      if (request.method === "GET" && url.pathname === "/api/schema") {
        return json(response, 200, {
          commands: schema,
          defaults: { environment: options.environment },
        });
      }

      if (request.method === "POST" && url.pathname === "/api/completions") {
        const body = await requestBody(request);
        const command = findUiCommand(schema, stringPath(body.command));
        if (!command) throw new UiInputError("Command is not available in this UI.");
        const field = body.field;
        if (typeof field !== "object" || field === null || Array.isArray(field)) {
          throw new UiInputError("field must be an object.");
        }
        const typedField = field as Record<string, unknown>;
        if (
          (typedField.kind !== "argument" && typedField.kind !== "option") ||
          typeof typedField.name !== "string"
        ) {
          throw new UiInputError("field must identify an argument or option.");
        }
        if (body.partial !== undefined && typeof body.partial !== "string") {
          throw new UiInputError("partial must be a string.");
        }
        const words = completionWords(command, body.arguments, body.options, {
          kind: typedField.kind,
          name: typedField.name,
        });
        const parameter =
          typedField.kind === "argument"
            ? command.arguments.find((argument) => argument.name === typedField.name)
            : command.options.find((option) => option.key === typedField.name);
        const domain = parameter?.valueDomain;
        if (domain) {
          const selectedEnvironment = objectRecord(body.options).env;
          const sourceArgv = [...domain.source.command];
          if (typeof selectedEnvironment === "string" && selectedEnvironment !== "") {
            sourceArgv.push("--env", selectedEnvironment);
          }
          const cacheKey = JSON.stringify(sourceArgv);
          let cached = valueDomainCache.get(cacheKey);
          if (!cached || cached.expires < Date.now()) {
            const result = await runner(sourceArgv, { cwd: options.cwd });
            if (result.exitCode !== 0) {
              throw new Error(result.stderr.trim() || `Value-domain command exited ${result.exitCode}.`);
            }
            const rows: unknown = JSON.parse(result.stdout);
            if (!Array.isArray(rows)) throw new Error("Value-domain command did not return a JSON array.");
            const suggestions = rows.flatMap((value): ValueSuggestion[] => {
              const row = objectRecord(value);
              const selected = row[domain.source.valueField];
              if (typeof selected !== "string" && typeof selected !== "number") return [];
              return [
                {
                  value: String(selected),
                  label: suggestionLabel(row, domain.source.labelFields) || String(selected),
                },
              ];
            });
            cached = { expires: Date.now() + VALUE_DOMAIN_CACHE_MS, suggestions };
            valueDomainCache.set(cacheKey, cached);
          }
          const partial = ((body.partial as string) ?? "").toLocaleLowerCase();
          const suggestions = cached.suggestions
            .filter(
              (suggestion) =>
                partial === "" ||
                suggestion.value.toLocaleLowerCase().includes(partial) ||
                suggestion.label.toLocaleLowerCase().includes(partial),
            )
            .slice(0, MAX_SUGGESTIONS);
          return json(response, 200, { suggestions });
        }
        const candidates = await completionCandidates(program, words, (body.partial as string) ?? "");
        return json(response, 200, {
          suggestions: candidates.map((value) => ({ value, label: value })),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const body = await requestBody(request);
        const command = findUiCommand(schema, stringPath(body.command));
        if (!command) throw new UiInputError("Command is not available in this UI.");
        const invocation = buildUiInvocation(command, body);
        const result = await runner(invocation.argv, { cwd: options.cwd });
        return json(response, 200, { ...result, reportOutputs: invocation.reportOutputs });
      }

      json(response, 404, { error: "Not found." });
    } catch (error) {
      if (error instanceof UiInputError || error instanceof SyntaxError) {
        json(response, 400, { error: error.message });
      } else {
        json(response, 500, {
          error: error instanceof Error ? error.message : "Internal server error.",
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
  return {
    server,
    origin,
    bootstrapUrl: `${origin}/#bootstrap=${encodeURIComponent(bootstrapSecret)}`,
  };
}
