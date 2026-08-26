/**
 * Error rendering shared by every adapter and by the application layer.
 *
 * This lives outside `src/ui.ts` on purpose: the application layer must not import the terminal
 * presenter, but it still has to produce the SAME error text — an HTTP status plus a truncated
 * response body (#50, #71) — in the messages it returns to whichever adapter is listening.
 */
import { CtApiError } from "./ctClient.js";

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
 * Render a caught error. For {@link CtApiError} this surfaces the HTTP status + response body —
 * without it, a failing `ct get raw` (or any API call) prints only "✗ GET ... failed" with no way
 * to see what ChurchTools actually said (#50).
 */
export function formatError(err: unknown): string {
  if (err instanceof CtApiError) {
    const body = formatBody(err.body);
    return `${err.message} (HTTP ${err.status})${body ? `\n${body}` : ""}`;
  }
  return err instanceof Error ? err.message : String(err);
}
