import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWorkspace } from "../../src/application/operations/workspace.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workspace inspection", () => {
  it("lists non-secret environment targets in declaration order", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ct-workspace-"));
    directories.push(cwd);
    await writeFile(
      join(cwd, "ct.envs.json"),
      JSON.stringify({
        environments: {
          test: {
            host: "https://test.example.church.tools/",
            state: "instances/test.example.church.tools/ct-state.test.example.church.tools.json",
            tokenEnv: "CT_TEST_TOKEN",
          },
          prod: {
            host: "https://example.church.tools",
            state: "instances/example.church.tools/ct-state.example.church.tools.json",
            protected: true,
          },
        },
      }),
    );

    const result = await inspectWorkspace({ cwd });

    expect(result.process).toMatchObject({ configPath: "ct.config.ts", environmentsPath: "ct.envs.json" });
    expect(result.environments).toEqual([
      {
        name: "test",
        host: "https://test.example.church.tools",
        statePath: "instances/test.example.church.tools/ct-state.test.example.church.tools.json",
        protected: false,
      },
      {
        name: "prod",
        host: "https://example.church.tools",
        statePath: "instances/example.church.tools/ct-state.example.church.tools.json",
        protected: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("CT_TEST_TOKEN");
    expect(result.requiresEnvironment).toBe(true);
  });

  it("preserves the environment-less single-host project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ct-workspace-"));
    directories.push(cwd);

    await expect(inspectWorkspace({ cwd })).resolves.toMatchObject({
      environments: [],
      selectedEnvironment: null,
      requiresEnvironment: false,
    });
  });
});
