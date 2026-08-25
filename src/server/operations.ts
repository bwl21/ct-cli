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
  executePreparedDestroy,
  prepareDestroy,
  type DestroyRequest,
  type DestroyResult,
  type PreparedDestroy,
  type PreparedDestroyExecution,
} from "../application/operations/destroy.js";
import { runPlan, type PlanRequest, type PlanResult } from "../application/operations/plan.js";
import { InMemoryMutationLock, PreparedOperationStore } from "../application/prepared-operation-store.js";
import type { OperationObserver } from "../application/ports.js";

export interface ServerOperationCatalog {
  authStatus(request: AuthStatusRequest): Promise<AuthStatusResult>;
  plan(request: PlanRequest): Promise<PlanResult>;
  prepareApply(request: ApplyRequest): Promise<PreparedApply>;
  executeApply(id: string, proof?: ConfirmationProof): Promise<ApplyResult>;
  prepareDestroy(request: DestroyRequest): Promise<PreparedDestroy>;
  executeDestroy(id: string, proof?: ConfirmationProof): Promise<DestroyResult>;
}

export interface ServerOperationCatalogOptions {
  observerFor?: (operationId: string) => OperationObserver;
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
    prepareApply: (request) => core.prepareApply(request, { store: applyStore }),
    executeApply: (id, proof) =>
      core.executePreparedApply({ id }, proof, {
        store: applyStore,
        lock: mutationLock,
        observer: options.observerFor?.(id),
      }),
    prepareDestroy: (request) => core.prepareDestroy(request, { store: destroyStore }),
    executeDestroy: (id, proof) =>
      core.executePreparedDestroy({ id }, proof, {
        store: destroyStore,
        lock: mutationLock,
        observer: options.observerFor?.(id),
      }),
  };
}
