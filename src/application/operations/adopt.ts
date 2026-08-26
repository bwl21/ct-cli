import { authedSession, type AuthedSession } from "../../api/session.js";
import { configSnippet, resourceType } from "../../resources/registry.js";
import { ReverseResolver } from "../../resolve/reverse.js";
import { chooseAdoptKey, loadState, saveState, upsert, type UpsertAction } from "../../state/state.js";
import type { CtWarning, OperationResult, ProjectRequest } from "../contracts.js";
import { InMemoryMutationLock } from "../prepared-operation-store.js";
import { systemClock, type Clock, type MutationLock } from "../ports.js";
import { resolveProject, type ProjectResolutionDependencies } from "../project.js";

export interface AdoptResourceRequest extends ProjectRequest {
  type: string;
  id: string | number;
  key?: string;
  rekey?: boolean;
  dryRun?: boolean;
}

export interface AdoptResourceValue {
  type: string;
  id: number;
  key: string;
  fields: Record<string, unknown>;
  config: string;
  action: UpsertAction | null;
  dryRun: boolean;
}

export type AdoptResourceResult = OperationResult<AdoptResourceValue>;

type ReverseResolverLike = Pick<ReverseResolver, "sugarFields">;

export interface AdoptOperationDependencies {
  project?: ProjectResolutionDependencies;
  resolveProject?: typeof resolveProject;
  loadState?: typeof loadState;
  saveState?: typeof saveState;
  authedSession?: () => Promise<AuthedSession>;
  createReverseResolver?: (client: AuthedSession["client"]) => ReverseResolverLike;
  clock?: Clock;
  lock?: MutationLock;
}

const defaultLock = new InMemoryMutationLock();

function parseId(raw: string | number): number {
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid id "${raw}" — expected a non-negative integer.`);
  }
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id)) throw new Error(`Invalid id "${raw}" — expected a safe integer.`);
  return id;
}

/** Adopt one non-group resource; group bulk/capture and grants remain separate operations. */
export async function runAdoptResource(
  request: AdoptResourceRequest,
  dependencies: AdoptOperationDependencies = {},
): Promise<AdoptResourceResult> {
  const spec = resourceType(request.type);
  const id = parseId(request.id);
  const project = await (dependencies.resolveProject ?? resolveProject)(request, dependencies.project);
  const lock = dependencies.lock ?? defaultLock;
  return lock.runExclusive(project.statePath, async () => {
    const state = await (dependencies.loadState ?? loadState)(project.statePath, project.host);
    const { client } = await (dependencies.authedSession ?? authedSession)();
    const resource = spec.fetchOne
      ? await spec.fetchOne(client, id)
      : await client.get<Record<string, unknown>>(spec.itemPath(id));
    if (!resource) throw new Error(`No ${request.type} with id ${id} exists in ChurchTools.`);

    const choice = chooseAdoptKey(state, request.type, id, spec.deriveKey(resource), {
      explicitKey: request.key,
      rekey: request.rekey,
    });
    if (!choice.key) throw new Error("Could not derive a logical key — pass --key explicitly.");
    const warnings: CtWarning[] = [];
    if (choice.wouldBecome) {
      warnings.push({
        code: "ADOPT_KEY_PRESERVED",
        message:
          `${choice.key}: key would change to "${choice.wouldBecome}" (derived from the live name). ` +
          `Keeping the adopted key. Pass --rekey to change it.`,
      });
    }
    const fields = spec.managedFields(resource);
    const reverse = (dependencies.createReverseResolver ?? ((value) => new ReverseResolver(value)))(client);
    const { fields: sugared, todos } = await reverse.sugarFields(fields);
    const config = configSnippet(request.type, choice.key, sugared, { todos });
    let action: UpsertAction | null = null;
    if (!request.dryRun) {
      action = upsert(
        state,
        { type: request.type, id, key: choice.key, fields },
        (dependencies.clock ?? systemClock).now().toISOString(),
      );
      await (dependencies.saveState ?? saveState)(project.statePath, state);
      if (action === "updated") {
        warnings.push({
          code: "ADOPT_ALREADY_MANAGED",
          message: "This resource was already managed — its snapshot was refreshed.",
        });
      }
    }
    return {
      operation: "adopt",
      project,
      warnings,
      value: {
        type: request.type,
        id,
        key: choice.key,
        fields,
        config,
        action,
        dryRun: request.dryRun ?? false,
      },
    };
  });
}
