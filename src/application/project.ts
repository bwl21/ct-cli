import { resolve } from "node:path";
import { access } from "node:fs/promises";
import { resolveConfig } from "../config.js";
import { resolveConfigPath } from "../config/load.js";
import { loadEnvProfile, loadEnvProfiles, resolveEnvsPath, type EnvProfile } from "../env/envs.js";
import { resolveStatePath } from "../state/state.js";
import type { ProjectRequest, ResolvedProjectInfo } from "./contracts.js";
import { CtApplicationError } from "./errors.js";

export interface ProjectResolutionDependencies {
  /** Runtime variables to resolve and wire. Defaults to process.env for CLI compatibility. */
  env?: NodeJS.ProcessEnv;
  /** Base cwd provider, injectable so tests and a future server never need process.chdir(). */
  cwd?: () => string;
  /** Stored-login host reader; the production default remains the existing keychain lookup. */
  readStoredHost?: () => Promise<string | null>;
  /** Environment catalog reader, injectable for selection-guard tests. */
  loadEnvProfiles?: typeof loadEnvProfiles;
  /** File probe used by the explicit environment guard. */
  pathExists?: (path: string) => Promise<boolean>;
}

function absoluteFrom(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function wireProfile(profile: EnvProfile, env: NodeJS.ProcessEnv): void {
  // A selected profile is authoritative and deliberately overrides ambient CT_HOST.
  env.CT_HOST = profile.host;
  if (profile.tokenEnv) {
    const token = env[profile.tokenEnv]?.trim();
    if (token) env.CT_LOGINTOKEN = token;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (caught) {
    if (
      typeof caught === "object" &&
      caught !== null &&
      "code" in caught &&
      (caught as { code?: string }).code === "ENOENT"
    ) {
      return false;
    }
    throw caught;
  }
}

/**
 * Resolve the common, non-secret project context for every application operation.
 *
 * Precedence remains identical to the CLI: explicit request → environment variable → default;
 * a selected environment supplies the authoritative host and state fallback, while CT_STATE may
 * still override that fallback. Relative paths are anchored to request.cwd instead of whichever
 * directory an HTTP server happens to use.
 */
export async function resolveProject(
  request: ProjectRequest = {},
  dependencies: ProjectResolutionDependencies = {},
): Promise<ResolvedProjectInfo> {
  const env = dependencies.env ?? process.env;
  const baseCwd = dependencies.cwd?.() ?? process.cwd();
  const cwd = resolve(baseCwd, request.cwd ?? ".");
  const environmentsPath = absoluteFrom(cwd, resolveEnvsPath(undefined, env));

  if (!request.environment && (await (dependencies.pathExists ?? pathExists)(environmentsPath))) {
    const profiles = await (dependencies.loadEnvProfiles ?? loadEnvProfiles)(environmentsPath);
    if (profiles.length > 0) {
      const names = profiles.map(({ name }) => name);
      throw new CtApplicationError(
        "ENVIRONMENT_REQUIRED",
        `Choose an environment explicitly with --env <name>. Defined: ${names.join(", ")}.`,
        { details: { environments: names } },
      );
    }
  }

  const profile = request.environment ? await loadEnvProfile(request.environment, environmentsPath) : null;
  if (profile) wireProfile(profile, env);

  const configDisplayPath = resolveConfigPath(request.configPath, env);
  const stateDisplayPath = resolveStatePath(request.statePath, env, profile?.statePath);
  const configPath = absoluteFrom(cwd, configDisplayPath);
  const statePath = absoluteFrom(cwd, stateDisplayPath);
  const { host } = await resolveConfig(env, dependencies.readStoredHost);

  return {
    cwd,
    configPath,
    statePath,
    environmentsPath,
    configDisplayPath,
    stateDisplayPath,
    environment: profile?.name ?? null,
    protected: profile?.protected ?? false,
    host,
  };
}
