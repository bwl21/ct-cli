import { describe, expect, it, vi } from "vitest";
import type { CoverageReport } from "../../src/coverage/report.js";
import {
  runCoverage,
  type CoverageOperationDependencies,
} from "../../src/application/operations/coverage.js";
import { emptyState } from "../../src/state/state.js";

const host = "https://example.church.tools";
const report: CoverageReport = {
  host,
  groups: { total: 2, managed: 0, dynamic: 0, managedDynamic: 0 },
  grants: {
    authored: 2,
    roleInstances: 2,
    declarable: 1,
    blocked: 1,
    blockingDimensions: ["cc_html_template"],
  },
  byType: [{ groupTypeId: 7, name: "Local Lead", total: 2, managed: 0, dynamic: 0, unmanagedWithGrants: 2 }],
  roleInstances: [
    {
      domainId: 1,
      groupId: 10,
      groupName: "A",
      groupTypeId: 7,
      roleName: "Lead",
      managedGroupKey: null,
      verdict: { declarable: true, grantCount: 1, blockedBy: [], unknownAuthIds: [] },
    },
    {
      domainId: 2,
      groupId: 11,
      groupName: "B",
      groupTypeId: 7,
      roleName: "Lead",
      managedGroupKey: null,
      verdict: {
        declarable: false,
        grantCount: 1,
        blockedBy: ["cc_html_template"],
        unknownAuthIds: [],
      },
    },
  ],
};

function dependencies(events: string[]): CoverageOperationDependencies {
  return {
    observer: {
      emit: (event) => events.push(event.type === "phase-started" ? event.phase : event.type),
    },
    resolveProject: vi.fn(async () => ({
      cwd: "/project",
      configPath: "/project/ct.config.ts",
      statePath: "/project/ct-state.dev.json",
      environmentsPath: "/project/ct.envs.json",
      configDisplayPath: "ct.config.ts",
      stateDisplayPath: "ct-state.dev.json",
      environment: "dev",
      protected: false,
      host,
    })),
    loadState: vi.fn(async () => emptyState(host)),
    loadHostCatalog: vi.fn(async () => "/project/.ct/catalog.json"),
    authedSession: vi.fn(async () => ({
      client: {},
      me: { id: 1 },
    })) as unknown as CoverageOperationDependencies["authedSession"],
    collectCoverage: vi.fn(async () => report),
  };
}

describe("runCoverage", () => {
  it("returns one canonical filtered report and structured project metadata", async () => {
    const events: string[] = [];
    const result = await runCoverage({ type: "local_lead", blocked: true }, dependencies(events));

    expect(result).toMatchObject({
      operation: "coverage",
      project: { environment: "dev", host },
      value: { permissionCatalogPath: "/project/.ct/catalog.json" },
    });
    expect(result.value.report.roleInstances.map((item) => item.domainId)).toEqual([2]);
    expect(events).toEqual(["resolve-project", "load-project", "build-coverage"]);
  });

  it("rejects an unknown group type before returning a misleading empty report", async () => {
    await expect(runCoverage({ type: "unknown" }, dependencies([]))).rejects.toThrow(
      '--type "unknown": no group type matches',
    );
  });
});
