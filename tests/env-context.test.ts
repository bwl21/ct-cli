import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEnv } from "../src/env/context.js";

const envsPath = join(tmpdir(), `ct-cli-envctx-${process.pid}.json`);

async function writeEnvs(): Promise<void> {
  await writeFile(
    envsPath,
    JSON.stringify({
      environments: {
        dev: { host: "https://mychurch-dev.church.tools" },
        prod: {
          host: "https://mychurch.church.tools",
          state: "custom-prod-state.json",
          protected: true,
          tokenEnv: "CT_PROD_TOKEN",
        },
      },
    }),
    "utf8",
  );
}

afterEach(async () => {
  await rm(envsPath, { force: true });
});

describe("prepareEnv without --env (backward compat)", () => {
  it("does not touch the env and resolves the default state path", async () => {
    const env: NodeJS.ProcessEnv = {};
    const result = await prepareEnv({}, env);
    expect(result).toEqual({ name: null, protected: false, statePath: "ct-state.json" });
    expect(env.CT_HOST).toBeUndefined();
    expect(env.CT_LOGINTOKEN).toBeUndefined();
  });

  it("honours an explicit --state and CT_STATE with no --env", async () => {
    expect((await prepareEnv({ state: "s.json" }, {})).statePath).toBe("s.json");
    expect((await prepareEnv({}, { CT_STATE: "e.json" })).statePath).toBe("e.json");
  });
});

describe("prepareEnv with --env", () => {
  it("wires the profile host into the env and defaults the per-env state path", async () => {
    await writeEnvs();
    const env: NodeJS.ProcessEnv = { CT_ENVS: envsPath };
    const result = await prepareEnv({ env: "dev" }, env);
    expect(result).toEqual({ name: "dev", protected: false, statePath: "ct-state.dev.json" });
    expect(env.CT_HOST).toBe("https://mychurch-dev.church.tools");
  });

  it("uses the profile state override and surfaces the protected flag", async () => {
    await writeEnvs();
    const env: NodeJS.ProcessEnv = { CT_ENVS: envsPath };
    const result = await prepareEnv({ env: "prod" }, env);
    expect(result).toEqual({
      name: "prod",
      protected: true,
      statePath: "custom-prod-state.json",
    });
    expect(env.CT_HOST).toBe("https://mychurch.church.tools");
  });

  it("copies the profile's tokenEnv value into CT_LOGINTOKEN (CI path) when present", async () => {
    await writeEnvs();
    const env: NodeJS.ProcessEnv = { CT_ENVS: envsPath, CT_PROD_TOKEN: "prod-secret" };
    await prepareEnv({ env: "prod" }, env);
    expect(env.CT_LOGINTOKEN).toBe("prod-secret");
  });

  it("leaves CT_LOGINTOKEN untouched when the referenced tokenEnv var is unset", async () => {
    await writeEnvs();
    const env: NodeJS.ProcessEnv = { CT_ENVS: envsPath };
    await prepareEnv({ env: "prod" }, env);
    expect(env.CT_LOGINTOKEN).toBeUndefined();
  });

  it("lets an explicit --state override the per-env default", async () => {
    await writeEnvs();
    const env: NodeJS.ProcessEnv = { CT_ENVS: envsPath };
    const result = await prepareEnv({ env: "dev", state: "override.json" }, env);
    expect(result.statePath).toBe("override.json");
  });
});
