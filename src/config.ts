/**
 * Runtime configuration for the CLI.
 *
 * The ChurchTools host is resolved from the environment so the same binary can
 * point at prod, a test instance, or a black-hole host. It never carries a
 * trailing slash and never includes the `/api` suffix — callers add path
 * segments themselves.
 */

const DEFAULT_HOST = "https://eqrm.church.tools";

export interface CtConfig {
  /** Base host, e.g. `https://eqrm.church.tools` (no trailing slash, no `/api`). */
  host: string;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): CtConfig {
  const host = env.CT_HOST?.trim() || DEFAULT_HOST;
  return { host: stripTrailingSlash(host) };
}
