import { access } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { resolveConfigPath } from "../../config/load.js";
import { loadEnvProfiles, resolveEnvsPath, type EnvProfile } from "../../env/envs.js";
import type { ProjectRequest } from "../contracts.js";

export interface WorkspaceEnvironment {
  name: string;
  host: string;
  statePath: string;
  protected: boolean;
}

export interface WorkspaceResult {
  process: {
    name: string;
    configPath: string;
    environmentsPath: string;
  };
  environments: WorkspaceEnvironment[];
  selectedEnvironment: string | null;
  requiresEnvironment: boolean;
}

export interface WorkspaceDependencies {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  pathExists?: (path: string) => Promise<boolean>;
  loadEnvProfiles?: (path: string) => Promise<EnvProfile[]>;
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

/** Discover the non-secret, process-local choices a CLI or UI may present to an operator. */
export async function inspectWorkspace(
  request: ProjectRequest = {},
  dependencies: WorkspaceDependencies = {},
): Promise<WorkspaceResult> {
  const env = dependencies.env ?? process.env;
  const baseCwd = dependencies.cwd?.() ?? process.cwd();
  const cwd = resolve(baseCwd, request.cwd ?? ".");
  const configPath = resolveConfigPath(request.configPath, env);
  const environmentsPath = resolveEnvsPath(undefined, env);
  const absoluteEnvironmentsPath = resolve(cwd, environmentsPath);
  const exists = await (dependencies.pathExists ?? pathExists)(absoluteEnvironmentsPath);
  const profiles = exists
    ? await (dependencies.loadEnvProfiles ?? loadEnvProfiles)(absoluteEnvironmentsPath)
    : [];
  const environments = profiles.map(({ name, host, statePath, protected: isProtected }) => ({
    name,
    host,
    statePath,
    protected: isProtected,
  }));

  if (request.environment && !environments.some(({ name }) => name === request.environment)) {
    const known = environments.map(({ name }) => name).join(", ") || "(none defined)";
    throw new Error(`Unknown environment "${request.environment}". Defined: ${known}.`);
  }

  return {
    process: { name: basename(cwd), configPath, environmentsPath },
    environments,
    selectedEnvironment: request.environment ?? null,
    requiresEnvironment: environments.length > 0,
  };
}
