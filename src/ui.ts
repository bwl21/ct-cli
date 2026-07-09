/**
 * Tiny terminal output helpers. Kept dependency-light on purpose.
 */
import pc from "picocolors";
import { CtApiError } from "./api/ctClient.js";

/** Response bodies beyond this are truncated so a huge HTML/JSON dump doesn't flood the terminal. */
const MAX_BODY_CHARS = 2000;

function formatBody(body: unknown): string {
  if (body === null || body === undefined) {
    return "";
  }
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  if (text.length > MAX_BODY_CHARS) {
    return `${text.slice(0, MAX_BODY_CHARS)}\n… (truncated, ${text.length} chars total)`;
  }
  return text;
}

/**
 * Render a caught error for the terminal. For {@link CtApiError} this surfaces
 * the HTTP status + response body — without it, a failing `ct get raw` (or any
 * API call) prints only "✗ GET ... failed" with no way to see what ChurchTools
 * actually said (#50).
 */
export function formatError(err: unknown): string {
  if (err instanceof CtApiError) {
    const body = formatBody(err.body);
    return `${err.message} (HTTP ${err.status})${body ? `\n${body}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function info(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function success(message: string): void {
  process.stderr.write(`${pc.green("✓")} ${message}\n`);
}

export function warn(message: string): void {
  process.stderr.write(`${pc.yellow("!")} ${message}\n`);
}

export function error(message: string): void {
  process.stderr.write(`${pc.red("✗")} ${message}\n`);
}

/** Machine-readable payloads go to stdout so they can be piped/`jq`-ed. */
export function out(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
