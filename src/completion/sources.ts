/**
 * Offline data sources for tab completion (#132).
 *
 * Everything here runs on a Tab keypress, which imposes two hard rules:
 *
 * - **Nothing contacts ChurchTools and nothing reads a credential.** Completion is
 *   allowed to look at the local, non-secret config repo (`ct.envs.json`, the state
 *   file, the working directory) and at nothing else. There is no client, no token
 *   store and no `prepareEnv` in this module, on purpose.
 * - **A failure yields no candidates, never an error and never a hang.** A missing,
 *   unreadable, malformed or slow file is the normal case while a config repo is
 *   being edited; the shell must simply offer nothing instead of printing a stack
 *   trace into the command line. So every read is wrapped in {@link offline}.
 *
 * That is also why these read the files directly rather than going through
 * `loadEnvProfile`/`loadState`: those validate and throw friendly errors, which is
 * right for a command and wrong for a keypress.
 */
import { readdir, readFile } from "node:fs/promises";
import { RESOURCES } from "../resources/registry.js";

/** A source slower than this is abandoned — the shell must never wait on `ct`. */
const SOURCE_TIMEOUT_MS = 150;

/** Run a source with the two guarantees above: no throw, no hang, empty on failure. */
async function offline(read: () => Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandon = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), SOURCE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read().catch(() => []), abandon]);
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function objectKeys(value: unknown, field: string): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const nested = (value as Record<string, unknown>)[field];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return [];
  return Object.keys(nested as Record<string, unknown>);
}

/** The environment names declared in the profile file — the values `--env` accepts. */
export function envNames(path: string): Promise<string[]> {
  return offline(async () => objectKeys(JSON.parse(await readFile(path, "utf8")), "environments"));
}

/** The logical keys under management in a state file — the values `ct state rm` accepts. */
export function stateKeys(path: string): Promise<string[]> {
  return offline(async () => objectKeys(JSON.parse(await readFile(path, "utf8")), "resources"));
}

/** The resource types the registry knows, straight from the registry so it cannot drift. */
export function resourceTypes(): string[] {
  return Object.keys(RESOURCES);
}

/**
 * Filesystem candidates for a partially typed path.
 *
 * The shells filter the returned list against the word being typed, so the entries
 * must carry the directory prefix the user already typed. Dot-entries are offered
 * only once the user has typed a dot, matching what every shell does by default.
 */
export function paths(partial: string, kind: "file" | "directory"): Promise<string[]> {
  return offline(async () => {
    const cut = partial.lastIndexOf("/");
    const prefix = cut === -1 ? "" : partial.slice(0, cut + 1);
    const base = partial.slice(cut + 1);
    const entries = await readdir(prefix === "" ? "." : prefix, { withFileTypes: true });
    return entries
      .filter((entry) => base.startsWith(".") || !entry.name.startsWith("."))
      .filter((entry) => kind === "file" || entry.isDirectory())
      .map((entry) => `${prefix}${entry.name}${entry.isDirectory() ? "/" : ""}`);
  });
}
