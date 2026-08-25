import { describe, expect, it, vi } from "vitest";
import { runAuthLogin, runAuthLogout, runAuthStatus } from "../../src/application/operations/auth.js";

const host = "https://example.church.tools";

describe("runAuthStatus", () => {
  it("returns a non-secret identity for one environment", async () => {
    const result = await runAuthStatus(
      { environment: "dev" },
      {
        resolveProject: vi.fn(async () => ({
          cwd: "/project",
          configPath: "/project/ct.config.ts",
          statePath: "/project/state.json",
          environmentsPath: "/project/ct.envs.json",
          configDisplayPath: "ct.config.ts",
          stateDisplayPath: "state.json",
          environment: "dev",
          protected: false,
          host,
        })),
        readToken: vi.fn(async () => "secret-that-must-not-be-returned"),
        authedSession: vi.fn(async () => ({
          client: {},
          me: { id: 7, firstName: "Ada", lastName: "Lovelace" },
        })) as never,
      },
    );
    expect(result).toMatchObject({
      operation: "auth",
      scope: "single",
      host,
      identity: { id: 7, firstName: "Ada" },
      authenticated: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-that-must-not-be-returned");
  });

  it("returns every environment status without flattening token sources into secrets", async () => {
    const statuses = [
      {
        name: "dev",
        host,
        source: { kind: "stored" as const },
        identity: { id: 7 },
      },
    ];
    const result = await runAuthStatus(
      { all: true },
      {
        cwd: () => "/project",
        loadEnvProfiles: vi.fn(async () => [
          { name: "dev", host, statePath: "state.json", protected: false },
        ]),
        checkAllEnvAuth: vi.fn(async () => statuses),
      },
    );
    expect(result).toMatchObject({ scope: "all", authenticated: true, environments: statuses });
  });
});

describe("auth mutations", () => {
  it("verifies and stores a login token but never returns the secret", async () => {
    const authenticate = vi.fn(async () => ({ id: 7, firstName: "Ada", lastName: "Lovelace" }));
    const storeCredentials = vi.fn(async () => "test keychain");
    const result = await runAuthLogin(
      { host: "https://example.church.tools/", token: "  super-secret  " },
      {
        createClient: (() => ({
          authenticate,
          get: vi.fn(async () => ({ version: "3.140.0" })),
        })) as never,
        storeCredentials,
      },
    );

    expect(authenticate).toHaveBeenCalledWith("super-secret", { fresh: true });
    expect(storeCredentials).toHaveBeenCalledWith({ host, token: "super-secret" });
    expect(result).toMatchObject({
      operation: "auth",
      action: "login",
      host,
      identity: { id: 7 },
      storage: "test keychain",
      churchToolsVersion: "3.140.0",
      supportedVersion: true,
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("logs out exactly the host selected by an environment", async () => {
    const clearCredentials = vi.fn(async () => ({ clearedDefault: true }));
    const result = await runAuthLogout(
      { cwd: "/project", environment: "prod" },
      {
        env: {},
        cwd: () => "/ignored",
        loadEnvProfile: vi.fn(async (_name, path) => {
          expect(path).toBe("/project/ct.envs.json");
          return { name: "prod", host, statePath: "state.json", protected: true };
        }),
        clearCredentials,
      },
    );

    expect(clearCredentials).toHaveBeenCalledWith(host);
    expect(result).toEqual({
      operation: "auth",
      action: "logout",
      environment: "prod",
      host,
      clearedDefault: true,
    });
  });
});
