import { describe, expect, it, vi } from "vitest";
import { runAuthStatus } from "../../src/application/operations/auth.js";

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
