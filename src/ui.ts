/**
 * Tiny terminal output helpers. Kept dependency-light on purpose.
 */
import pc from "picocolors";

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
