/**
 * Persistence for the personal ChurchTools login token.
 *
 * Precedence when reading:
 *   1. `CT_LOGINTOKEN` environment variable (CI / one-off use)
 *   2. credentials file at `~/.config/ct-cli/credentials.json`
 *
 * TODO(Phase 1, #3): move the file store behind the macOS Keychain (e.g.
 * `security add-generic-password`) and keep the file only as a non-macOS
 * fallback. The interface below stays the same so callers don't change.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";

interface Credentials {
  host: string;
  token: string;
}

function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "ct-cli");
}

function credentialsPath(): string {
  return join(configDir(), "credentials.json");
}

export async function storeToken(host: string, token: string): Promise<string> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  const path = credentialsPath();
  const payload: Credentials = { host, token };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

export async function readToken(): Promise<string | null> {
  const fromEnv = process.env.CT_LOGINTOKEN?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const raw = await readFile(credentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Credentials>;
    return parsed.token?.trim() || null;
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  await rm(credentialsPath(), { force: true });
}
