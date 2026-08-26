import { loadConfig } from "../../config/load.js";
import { resourceType } from "../../resources/registry.js";
import { collectRefs, isRef, type Ref } from "../../resolve/refs.js";
import { loadState, saveState, type ManagedResource } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { InMemoryMutationLock } from "../prepared-operation-store.js";
import type { MutationLock } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface StateOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  loadConfig?: typeof loadConfig;
  lock?: MutationLock;
}

export type StateListResult = OperationResult<{ resources: ManagedResource[] }>;

export interface StateRemoveRequest extends ProjectRequest {
  type: string;
  key: string;
  force?: boolean;
  dryRun?: boolean;
}

export type StateRemoveResult = OperationResult<{
  entry: ManagedResource;
  removed: boolean;
  churchToolsContacted: false;
}>;

const defaultLock = new InMemoryMutationLock();

export async function listState(
  request: ProjectRequest = {},
  dependencies: StateOperationDependencies = {},
): Promise<StateListResult> {
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
  return {
    operation: "state",
    project,
    warnings: [],
    value: { resources: Object.values(state.resources) },
  };
}

async function declaredKeys(
  configPath: string,
  dependencies: StateOperationDependencies,
): Promise<Set<string>> {
  const { resources, permissions } = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const keys = new Set(resources.map((resource) => resource.key));
  const addRef = (ref: Ref): void => {
    if (ref.kind === "group-role") keys.add(ref.group);
    else if (ref.kind === "group-type-role") keys.add(ref.groupType);
    else if (ref.kind === "group-member-field") keys.add(ref.group);
    else keys.add(ref.key);
  };
  for (const ref of collectRefs(permissions)) addRef(ref);
  for (const permission of permissions) {
    for (const grant of permission.grants) {
      if (typeof grant === "string" || !Array.isArray(grant.scope)) continue;
      for (const entry of grant.scope) {
        if (typeof entry === "string" && entry.length > 0) keys.add(entry);
        else if (entry !== null && typeof entry === "object" && !isRef(entry)) {
          const values = Object.values(entry as Record<string, unknown>);
          if (values.length === 1 && typeof values[0] === "string" && values[0].length > 0) {
            keys.add(values[0]);
          }
        }
      }
    }
  }
  return keys;
}

export async function removeStateEntry(
  request: StateRemoveRequest,
  dependencies: StateOperationDependencies = {},
): Promise<StateRemoveResult> {
  resourceType(request.type);
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(project.statePath, async () => {
    const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
    const entry = state.resources[request.key];
    if (!entry) {
      throw new Error(
        `No entry "${request.key}" in ${project.stateDisplayPath}. List them with \`ct state list\`.`,
      );
    }
    if (entry.type !== request.type) {
      throw new Error(
        `"${request.key}" in ${project.stateDisplayPath} is a ${entry.type} (#${entry.id}), not a ${request.type}. ` +
          `Pass the right type, or list them with \`ct state list\`.`,
      );
    }

    const warnings: CtWarning[] = [];
    if (!request.force) {
      try {
        const declared = await declaredKeys(project.configPath, dependencies);
        if (declared.has(request.key)) {
          throw new Error(
            `"${request.key}" is still declared in the config, so removing it from state would make the next ` +
              `plan propose CREATING a resource that already exists on this host. Remove the ` +
              `declaration first, or pass --force if you are deleting both in the same change.`,
          );
        }
      } catch (caught) {
        if (caught instanceof Error && caught.message.includes("is still declared in the config"))
          throw caught;
        warnings.push({
          code: "CONFIG_UNREADABLE",
          message:
            `Could not read the config to check whether "${request.configPath ?? "the default config"}" still ` +
            `declares this key (${caught instanceof Error ? caught.message : String(caught)}) — removing anyway.`,
        });
      }
    }

    if (!request.dryRun) {
      delete state.resources[request.key];
      await (dependencies.saveState ?? saveState)(project.statePath, state);
    }
    return {
      operation: "state",
      project,
      warnings,
      value: { entry, removed: !request.dryRun, churchToolsContacted: false },
    };
  });
}
