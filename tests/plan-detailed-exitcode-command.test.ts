/**
 * Command-level `ct plan --detailed-exitcode` (#24), Terraform-style:
 *  - 0 = no changes, 1 = error (INCOMPLETE plan — never demoted to 2, even with pending changes),
 *    2 = changes pending (a resource action, OR a permission item with something to grant/revoke).
 *  - without the flag, exit code stays byte-identical to before (0 on a changed plan, 1 on INCOMPLETE).
 *  - drift alone (no actionable resource/permission change) does NOT set exit 2 — `apply` wouldn't
 *    write anything for it, so `--detailed-exitcode` mirrors what apply would actually do.
 *  - composes with `--json`: the exit code matches the JSON `summary.hasChanges`, and stdout stays
 *    pure JSON (the human header/render never leaks onto stdout under --json).
 * Mocks the plan pipeline (session/config/build/permissions) like plan-env-command.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/engine/types.js";
import type { PermissionPlanItem } from "../src/permissions/plan.js";

let mockPlan: Plan = { items: [] };
let mockFetchErrors: string[] = [];
let mockPermItems: PermissionPlanItem[] = [];
let mockPermFetchErrors: string[] = [];

vi.mock("../src/api/session.js", () => ({
  authedSession: vi.fn(async () => ({ client: { get: vi.fn(), version: "3.100.0" }, me: { id: 1 } })),
}));

vi.mock("../src/config/load.js", () => ({
  DEFAULT_CONFIG_PATH: "ct.config.ts",
  resolveConfigPath: (explicit?: string) => explicit ?? "ct.config.ts",
  loadConfig: vi.fn(async () => ({ resources: [], permissions: [], configDir: "." })),
}));

vi.mock("../src/engine/build.js", () => ({
  buildPlan: vi.fn(async () => ({ plan: mockPlan, actual: new Map(), fetchErrors: mockFetchErrors })),
}));

vi.mock("../src/permissions/plan.js", () => ({
  buildPermissionPlan: vi.fn(async () => ({
    items: mockPermItems,
    fetchErrors: mockPermFetchErrors,
    warnings: [],
  })),
}));

const { planCommand } = await import("../src/commands/plan.js");
const { saveState, emptyState } = await import("../src/state/state.js");

const HOST = "https://mychurch.church.tools";
const statePath = join(tmpdir(), `ct-cli-plan-detailed-exitcode-${process.pid}.json`);
const originalHost = process.env.CT_HOST;

let stdout = "";
let stdoutSpy: { mockRestore: () => void };

async function runPlan(args: string[]): Promise<void> {
  await planCommand().parseAsync(["--state", statePath, ...args], { from: "user" });
}

beforeEach(async () => {
  process.env.CT_HOST = HOST;
  await saveState(statePath, emptyState(HOST));
  mockPlan = { items: [] };
  mockFetchErrors = [];
  mockPermItems = [];
  mockPermFetchErrors = [];
  process.exitCode = 0;
  stdout = "";
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as (typeof process.stdout)["write"]);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  process.exitCode = 0;
  if (originalHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = originalHost;
  await rm(statePath, { force: true });
});

describe("ct plan --detailed-exitcode", () => {
  it("exits 0 when there are no changes at all", async () => {
    mockPlan = { items: [{ type: "campus", key: "mz", id: 0, action: "no-op", changes: [] }] };
    await runPlan(["--detailed-exitcode"]);
    expect(process.exitCode).toBe(0);
  });

  it("exits 2 when a resource change is pending", async () => {
    mockPlan = {
      items: [
        {
          type: "campus",
          key: "mz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz", source: "config" }],
        },
      ],
    };
    await runPlan(["--detailed-exitcode"]);
    expect(process.exitCode).toBe(2);
  });

  it("exits 2 when only a permission diff is pending (no resource changes)", async () => {
    mockPlan = { items: [{ type: "campus", key: "mz", id: 0, action: "no-op", changes: [] }] };
    mockPermItems = [
      {
        key: "team",
        domainType: "group_role",
        domainId: 1,
        diff: {
          toPut: [{ authId: 5, dataId: [], type: "grant" }],
          toDelete: [],
          preserved: [],
          preservedUnknown: [],
        },
      },
    ];
    await runPlan(["--detailed-exitcode"]);
    expect(process.exitCode).toBe(2);
  });

  it("exits 1 on an INCOMPLETE plan even with --detailed-exitcode (never 2)", async () => {
    mockPlan = {
      items: [
        {
          type: "campus",
          key: "mz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz", source: "config" }],
        },
      ],
    };
    mockFetchErrors = ["campus.other (#1): 500 Server Error"];
    await runPlan(["--detailed-exitcode"]);
    expect(process.exitCode).toBe(1);
  });

  it("exits 1 on INCOMPLETE without the flag too (pre-existing behaviour, unchanged)", async () => {
    mockFetchErrors = ["campus.other (#1): 500 Server Error"];
    await runPlan([]);
    expect(process.exitCode).toBe(1);
  });

  it("without the flag, a changed plan still exits 0 (flag-gated, not automatic)", async () => {
    mockPlan = {
      items: [
        {
          type: "campus",
          key: "mz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz", source: "config" }],
        },
      ],
    };
    await runPlan([]);
    expect(process.exitCode).toBe(0);
  });

  it("drift-only (no actionable change) does not itself trigger exit 2", async () => {
    mockPlan = {
      items: [
        {
          type: "campus",
          key: "mz",
          id: 0,
          action: "no-op",
          changes: [],
          drift: [{ field: "shortName", from: "MZ", to: "CHANGED" }],
        },
      ],
    };
    await runPlan(["--detailed-exitcode"]);
    expect(process.exitCode).toBe(0);
  });

  it("composes with --json: exit code matches summary.hasChanges, stdout is pure JSON", async () => {
    mockPlan = {
      items: [
        {
          type: "campus",
          key: "mz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz", source: "config" }],
        },
      ],
    };
    await runPlan(["--detailed-exitcode", "--json"]);
    expect(process.exitCode).toBe(2);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.hasChanges).toBe(true);
    expect(parsed.summary.resources).toEqual({ create: 1, update: 0, delete: 0, "no-op": 0 });
  });

  it("--json with no changes: summary.hasChanges is false and exit stays 0 even with the flag", async () => {
    mockPlan = { items: [{ type: "campus", key: "mz", id: 0, action: "no-op", changes: [] }] };
    await runPlan(["--detailed-exitcode", "--json"]);
    expect(process.exitCode).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.summary.hasChanges).toBe(false);
  });
});
