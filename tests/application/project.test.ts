import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../../src/application/project.js";
import { loadState } from "../../src/state/state.js";

const dirs: string[] = [];

async function projectDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ct-application-project-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveProject", () => {
  it("resolves the default config and state from cwd without changing single-host precedence", async () => {
    const cwd = await projectDir();
    const project = await resolveProject(
      { cwd },
      { env: {}, cwd: () => "/ignored", readStoredHost: async () => "https://stored.church.tools/" },
    );

    expect(project).toEqual({
      cwd,
      configPath: join(cwd, "ct.config.ts"),
      statePath: join(cwd, "ct-state.json"),
      environmentsPath: join(cwd, "ct.envs.json"),
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.json",
      environment: null,
      protected: false,
      host: "https://stored.church.tools",
    });
  });

  it("keeps explicit paths ahead of environment variables", async () => {
    const cwd = await projectDir();
    const project = await resolveProject(
      { cwd, configPath: "explicit.config.ts", statePath: "explicit-state.json" },
      {
        env: {
          CT_CONFIG: "environment.config.ts",
          CT_STATE: "environment-state.json",
          CT_HOST: "https://env.church.tools/",
        },
      },
    );

    expect(project.configPath).toBe(join(cwd, "explicit.config.ts"));
    expect(project.statePath).toBe(join(cwd, "explicit-state.json"));
    expect(project.configDisplayPath).toBe("explicit.config.ts");
    expect(project.stateDisplayPath).toBe("explicit-state.json");
    expect(project.host).toBe("https://env.church.tools");
  });

  it("selects one environment's host, state, protection and token reference", async () => {
    const cwd = await projectDir();
    await writeFile(
      join(cwd, "ct.envs.json"),
      JSON.stringify({
        environments: {
          prod: {
            host: "https://prod.church.tools/",
            state: "instances/prod/state.json",
            protected: true,
            tokenEnv: "CT_PROD_TOKEN",
          },
        },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      CT_HOST: "https://ambient.church.tools",
      CT_PROD_TOKEN: " secret-token ",
    };

    const project = await resolveProject({ cwd, environment: "prod" }, { env });

    expect(project).toMatchObject({
      environment: "prod",
      protected: true,
      host: "https://prod.church.tools",
      statePath: join(cwd, "instances/prod/state.json"),
    });
    expect(env.CT_HOST).toBe("https://prod.church.tools");
    expect(env.CT_LOGINTOKEN).toBe("secret-token");
  });

  it("requires an explicit environment when the project declares choices", async () => {
    const cwd = await projectDir();
    await writeFile(
      join(cwd, "ct.envs.json"),
      JSON.stringify({
        environments: {
          test: { host: "https://test.church.tools" },
          prod: { host: "https://prod.church.tools", protected: true },
        },
      }),
    );

    await expect(resolveProject({ cwd }, { env: {} })).rejects.toMatchObject({
      name: "CtApplicationError",
      code: "ENVIRONMENT_REQUIRED",
      details: { environments: ["test", "prod"] },
    });
  });

  it("keeps an empty environment catalog compatible with single-host setup", async () => {
    const cwd = await projectDir();
    await writeFile(join(cwd, "ct.envs.json"), JSON.stringify({ environments: {} }));

    await expect(
      resolveProject({ cwd }, { env: { CT_HOST: "https://single.church.tools" } }),
    ).resolves.toMatchObject({ environment: null, host: "https://single.church.tools" });
  });

  it("keeps CT_STATE above an environment's state fallback", async () => {
    const cwd = await projectDir();
    await writeFile(
      join(cwd, "profiles.json"),
      JSON.stringify({ environments: { test: { host: "https://test.church.tools" } } }),
    );
    const project = await resolveProject(
      { cwd, environment: "test" },
      { env: { CT_ENVS: "profiles.json", CT_STATE: "override.json" } },
    );

    expect(project.environmentsPath).toBe(join(cwd, "profiles.json"));
    expect(project.statePath).toBe(join(cwd, "override.json"));
  });

  it("preserves the host-bound state refusal", async () => {
    const cwd = await projectDir();
    await writeFile(
      join(cwd, "ct-state.json"),
      JSON.stringify({ version: 1, host: "https://other.church.tools", resources: {} }),
    );
    const project = await resolveProject({ cwd }, { env: { CT_HOST: "https://target.church.tools" } });

    await expect(loadState(project.statePath, project.host)).rejects.toThrow(/does not match CT_HOST/);
  });
});
