import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ENVS_PATH,
  resolveEnvsPath,
  defaultEnvStatePath,
  loadEnvProfile,
} from "../src/env/envs.js";

const envsPath = join(tmpdir(), `ct-cli-envs-${process.pid}.json`);

async function writeEnvs(obj: unknown): Promise<void> {
  await writeFile(envsPath, JSON.stringify(obj), "utf8");
}

afterEach(async () => {
  await rm(envsPath, { force: true });
});

describe("resolveEnvsPath", () => {
  it("prefers an explicit path, then CT_ENVS, then the default", () => {
    expect(resolveEnvsPath("x.json", {})).toBe("x.json");
    expect(resolveEnvsPath(undefined, { CT_ENVS: "y.json" })).toBe("y.json");
    expect(resolveEnvsPath(undefined, {})).toBe(DEFAULT_ENVS_PATH);
  });
});

describe("defaultEnvStatePath", () => {
  it("follows the ct-state.<env>.json convention", () => {
    expect(defaultEnvStatePath("dev")).toBe("ct-state.dev.json");
    expect(defaultEnvStatePath("prod")).toBe("ct-state.prod.json");
  });
});

describe("loadEnvProfile", () => {
  it("resolves a named profile with a normalized host and defaulted state path", async () => {
    await writeEnvs({
      environments: {
        dev: { host: "https://mychurch-dev.church.tools/" },
        prod: { host: "https://mychurch.church.tools", state: "ct-state.prod.json", protected: true },
      },
    });
    const dev = await loadEnvProfile("dev", envsPath);
    expect(dev).toEqual({
      name: "dev",
      host: "https://mychurch-dev.church.tools", // trailing slash stripped
      statePath: "ct-state.dev.json", // convention default
      protected: false,
      tokenEnv: undefined,
    });
    const prod = await loadEnvProfile("prod", envsPath);
    expect(prod).toMatchObject({
      name: "prod",
      host: "https://mychurch.church.tools",
      statePath: "ct-state.prod.json",
      protected: true,
    });
  });

  it("carries a tokenEnv reference when present", async () => {
    await writeEnvs({
      environments: { prod: { host: "https://mychurch.church.tools", tokenEnv: "CT_PROD_TOKEN" } },
    });
    expect((await loadEnvProfile("prod", envsPath)).tokenEnv).toBe("CT_PROD_TOKEN");
  });

  it("throws a friendly error when the envs file is missing", async () => {
    await expect(loadEnvProfile("dev", envsPath)).rejects.toThrow(
      /Environment profile file not found/,
    );
  });

  it("names the known environments when the requested one is absent", async () => {
    await writeEnvs({ environments: { dev: { host: "https://d.church.tools" } } });
    await expect(loadEnvProfile("prod", envsPath)).rejects.toThrow(
      /Unknown environment "prod".*dev/s,
    );
  });

  it("rejects a profile missing a host", async () => {
    await writeEnvs({ environments: { dev: { protected: true } } });
    await expect(loadEnvProfile("dev", envsPath)).rejects.toThrow(/missing.*host/i);
  });

  it("rejects a non-boolean protected flag", async () => {
    await writeEnvs({ environments: { dev: { host: "https://d.church.tools", protected: "yes" } } });
    await expect(loadEnvProfile("dev", envsPath)).rejects.toThrow(/protected/i);
  });

  it("rejects a file without an environments object", async () => {
    await writeEnvs({ dev: { host: "https://d.church.tools" } });
    await expect(loadEnvProfile("dev", envsPath)).rejects.toThrow(/environments/);
  });

  it("rejects invalid JSON with a friendly error", async () => {
    await writeFile(envsPath, "{ not json", "utf8");
    await expect(loadEnvProfile("dev", envsPath)).rejects.toThrow(/not valid JSON/);
  });
});
