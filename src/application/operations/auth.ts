import { resolve } from "node:path";
import { authedSession, type AuthedSession } from "../../api/session.js";
import type { WhoAmI } from "../../api/ctClient.js";
import { checkAllEnvAuth, type EnvAuthStatus } from "../../auth/status.js";
import { readToken } from "../../auth/tokenStore.js";
import { loadEnvProfiles, resolveEnvsPath } from "../../env/envs.js";
import { CtApplicationError } from "../errors.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface AuthStatusRequest {
  cwd?: string;
  environment?: string;
  all?: boolean;
}

export interface AuthStatusResult {
  operation: "auth";
  scope: "single" | "all";
  environment: string | null;
  host: string | null;
  identity: WhoAmI | null;
  environments: EnvAuthStatus[];
  authenticated: boolean;
  environmentsPath: string;
}

export interface AuthStatusDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  readToken?: typeof readToken;
  authedSession?: () => Promise<AuthedSession>;
  loadEnvProfiles?: typeof loadEnvProfiles;
  checkAllEnvAuth?: typeof checkAllEnvAuth;
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
}

/** Return authentication identity and source metadata without ever returning a token. */
export async function runAuthStatus(
  request: AuthStatusRequest = {},
  dependencies: AuthStatusDependencies = {},
): Promise<AuthStatusResult> {
  if (request.all && request.environment) {
    throw new Error("--all reports every environment; drop --env (or drop --all to check just one).");
  }
  const env = dependencies.env ?? process.env;
  const cwd = resolve(dependencies.cwd?.() ?? process.cwd(), request.cwd ?? ".");
  const environmentsPath = resolve(cwd, resolveEnvsPath(undefined, env));
  if (request.all) {
    const profiles = await (dependencies.loadEnvProfiles ?? loadEnvProfiles)(environmentsPath);
    const environments = await (dependencies.checkAllEnvAuth ?? checkAllEnvAuth)(profiles, { env });
    return {
      operation: "auth",
      scope: "all",
      environment: null,
      host: null,
      identity: null,
      environments,
      authenticated: environments.length > 0 && environments.every((status) => status.identity !== undefined),
      environmentsPath,
    };
  }

  let project;
  try {
    project = await (dependencies.resolveProject ?? resolveProject)(
      { cwd, environment: request.environment },
      { ...dependencies.project, env },
    );
  } catch (cause) {
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      "Not logged in. Run `ct auth login --host <url> --token <token>`.",
      { cause },
    );
  }
  if (!(await (dependencies.readToken ?? readToken)(project.host))) {
    throw new CtApplicationError(
      "AUTH_REQUIRED",
      `No token for ${project.host}. Run \`ct auth login --host ${project.host} --token <token>\`.`,
      { details: { host: project.host } },
    );
  }
  const { me } = await (dependencies.authedSession ?? authedSession)();
  return {
    operation: "auth",
    scope: "single",
    environment: project.environment,
    host: project.host,
    identity: me,
    environments: [],
    authenticated: true,
    environmentsPath,
  };
}
