import {
  executePreparedApply,
  prepareApply,
  type ApplyRequest,
  type ApplyResult,
  type ConfirmationProof,
  type PreparedApply,
  type PreparedApplyExecution,
} from "../application/operations/apply.js";
import {
  runAuthStatus,
  type AuthStatusRequest,
  type AuthStatusResult,
} from "../application/operations/auth.js";
import {
  runCoverage,
  type CoverageRequest,
  type CoverageResult,
} from "../application/operations/coverage.js";
import {
  executePreparedDestroy,
  prepareDestroy,
  type DestroyRequest,
  type DestroyResult,
  type PreparedDestroy,
  type PreparedDestroyExecution,
} from "../application/operations/destroy.js";
import { runPlan, type PlanRequest, type PlanResult } from "../application/operations/plan.js";
import { listState, type StateListResult } from "../application/operations/state.js";
import { InMemoryMutationLock, PreparedOperationStore } from "../application/prepared-operation-store.js";
import type { ProjectRequest } from "../application/contracts.js";
import type { OperationObserver } from "../application/ports.js";
import type { OperationEventStore } from "./operation-store.js";

export interface ServerOperationCatalog {
  authStatus(request: AuthStatusRequest): Promise<AuthStatusResult>;
  plan(request: PlanRequest): Promise<PlanResult>;
  coverage(request: CoverageRequest): Promise<CoverageResult>;
  state(request: ProjectRequest): Promise<StateListResult>;
  prepareApply(request: ApplyRequest): Promise<PreparedApply>;
  executeApply(id: string, proof?: ConfirmationProof): Promise<ApplyResult>;
  prepareDestroy(request: DestroyRequest): Promise<PreparedDestroy>;
  executeDestroy(id: string, proof?: ConfirmationProof): Promise<DestroyResult>;
}

export interface ServerOperationCatalogOptions {
  observerFor?: (operationId: string) => OperationObserver;
  events?: OperationEventStore;
  core?: Partial<{
    prepareApply: typeof prepareApply;
    executePreparedApply: typeof executePreparedApply;
    prepareDestroy: typeof prepareDestroy;
    executePreparedDestroy: typeof executePreparedDestroy;
  }>;
}

/**
 * Process-local operation catalog for one ct server. Apply and destroy keep separate typed payload
 * stores but deliberately share one mutation lock, so they cannot mutate the same state file at once.
 */
export function createServerOperationCatalog(
  options: ServerOperationCatalogOptions = {},
): ServerOperationCatalog {
  const applyStore = new PreparedOperationStore<PreparedApplyExecution>();
  const destroyStore = new PreparedOperationStore<PreparedDestroyExecution>();
  const mutationLock = new InMemoryMutationLock();
  const core = {
    prepareApply,
    executePreparedApply,
    prepareDestroy,
    executePreparedDestroy,
    ...options.core,
  };
  return {
    authStatus: (request) => runAuthStatus(request),
    plan: (request) => runPlan(request),
    coverage: (request) => runCoverage(request),
    state: (request) => listState(request),
    prepareApply: async (request) => {
      const prepared = await core.prepareApply(request, { store: applyStore });
      options.events?.open(prepared.id);
      return prepared;
    },
    executeApply: async (id, proof) => {
      try {
        const result = await core.executePreparedApply({ id }, proof, {
          store: applyStore,
          lock: mutationLock,
          observer: options.observerFor?.(id) ?? options.events?.observer(id),
        });
        options.events?.complete(id, "apply");
        return result;
      } catch (caught) {
        options.events?.fail(
          id,
          "apply",
          typeof caught === "object" && caught !== null && "code" in caught
            ? String(caught.code)
            : "INTERNAL_ERROR",
        );
        throw caught;
      }
    },
    prepareDestroy: async (request) => {
      const prepared = await core.prepareDestroy(request, { store: destroyStore });
      options.events?.open(prepared.id);
      return prepared;
    },
    executeDestroy: async (id, proof) => {
      try {
        const result = await core.executePreparedDestroy({ id }, proof, {
          store: destroyStore,
          lock: mutationLock,
          observer: options.observerFor?.(id) ?? options.events?.observer(id),
        });
        options.events?.complete(id, "destroy");
        return result;
      } catch (caught) {
        options.events?.fail(
          id,
          "destroy",
          typeof caught === "object" && caught !== null && "code" in caught
            ? String(caught.code)
            : "INTERNAL_ERROR",
        );
        throw caught;
      }
    },
  };
}
