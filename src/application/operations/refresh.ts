import type { CtClient } from "../../api/ctClient.js";
import { CtApiError } from "../../api/ctClient.js";
import { fetchDynamicGroupIds } from "../../api/dynamicGroups.js";
import { authedSession, type AuthedSession } from "../../api/session.js";
import { assertNotPeople } from "../../engine/guard.js";
import { loadState, type ManagedResource, type State } from "../../state/state.js";
import type { OperationResult, ProjectRequest } from "../contracts.js";
import { noopObserver, type OperationObserver } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface RefreshRequest extends ProjectRequest {
  group?: string;
  all?: boolean;
}

export interface RefreshCounts {
  created: number;
  updated: number;
  deleted: number;
}

export interface RefreshOutcome {
  key: string;
  id: number;
  counts: RefreshCounts | null;
  error: string | null;
}

export interface RefreshValue {
  outcomes: RefreshOutcome[];
  failed: number;
  fanOut: boolean;
}

export type RefreshResult = OperationResult<RefreshValue>;

export interface RefreshOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  authedSession?: () => Promise<AuthedSession>;
  selectTargets?: typeof selectRefreshTargets;
  observer?: OperationObserver;
}

/** Select only managed dynamic groups; the host-wide refresh endpoint remains unreachable. */
export async function selectRefreshTargets(
  client: Pick<CtClient, "getAll">,
  state: State,
  groupKey: string | undefined,
): Promise<ManagedResource[]> {
  const dynamicIds = await fetchDynamicGroupIds(client);
  if (groupKey !== undefined) {
    const managed = state.resources[groupKey];
    if (!managed || managed.type !== "group") {
      throw new Error(
        `--group "${groupKey}" is not a managed group in this state file. Adopt or declare it first.`,
      );
    }
    if (!dynamicIds.has(managed.id)) {
      throw new Error(
        `--group "${groupKey}" (#${managed.id}) is not a dynamic group on this host — there is no ruleset to evaluate.`,
      );
    }
    return [managed];
  }
  return Object.values(state.resources).filter(
    (resource) => resource.type === "group" && dynamicIds.has(resource.id),
  );
}

/** Canonical guarded refresh mutation used by CLI and future HTTP adapters. */
export async function runRefresh(
  request: RefreshRequest,
  dependencies: RefreshOperationDependencies = {},
): Promise<RefreshResult> {
  if (!request.group && !request.all) {
    throw new Error(
      "Specify --group <key> for one group, or --all to refresh every managed dynamic group. " +
        "Refreshing recomputes membership, so the fan-out is never the default.",
    );
  }
  if (request.group && request.all) throw new Error("Specify only one of: --group, --all.");

  const observer = dependencies.observer ?? noopObserver;
  observer.emit({ type: "phase-started", phase: "resolve-project" });
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  const { client } = await (dependencies.authedSession ?? authedSession)();
  observer.emit({ type: "phase-started", phase: "select-refresh-targets" });
  const targets = await (dependencies.selectTargets ?? selectRefreshTargets)(client, state, request.group);

  const outcomes: RefreshOutcome[] = [];
  observer.emit({ type: "phase-started", phase: "refresh-groups" });
  for (const target of targets) {
    const path = `/dynamicgroups/${target.id}/refresh`;
    assertNotPeople(path);
    try {
      const response = await client.request<RefreshCounts[]>("POST", path);
      outcomes.push({ key: target.key, id: target.id, counts: response?.[0] ?? null, error: null });
    } catch (caught) {
      outcomes.push({
        key: target.key,
        id: target.id,
        counts: null,
        error: caught instanceof CtApiError ? `HTTP ${caught.status}` : (caught as Error).message,
      });
    }
  }

  return {
    operation: "refresh",
    project,
    warnings:
      request.all && targets.length > 0
        ? [
            {
              code: "REFRESH_FAN_OUT",
              message: `Refreshing ${targets.length} managed dynamic group(s) — this recomputes membership.`,
            },
          ]
        : [],
    value: {
      outcomes,
      failed: outcomes.filter((outcome) => outcome.error !== null).length,
      fanOut: request.all ?? false,
    },
  };
}
