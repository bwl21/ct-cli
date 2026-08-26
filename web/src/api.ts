import type { AuthStatusResult } from "../../src/application/operations/auth.js";
import type {
  ApplyRequest,
  ApplyResult,
  ConfirmationProof,
  PreparedApply,
} from "../../src/application/operations/apply.js";
import type { CoverageRequest, CoverageResult } from "../../src/application/operations/coverage.js";
import type { PlanRequest, PlanResult } from "../../src/application/operations/plan.js";
import type { StateListResult } from "../../src/application/operations/state.js";
import type { ProjectRequest } from "../../src/application/contracts.js";
import type { OperationEvent } from "../../src/application/contracts.js";

interface ProblemResponse {
  error?: { code?: string; message?: string };
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function post<T>(path: string, body: object): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as ProblemResponse;
    throw new ApiError(
      problem.error?.code ?? `HTTP_${response.status}`,
      problem.error?.message ?? `Anfrage fehlgeschlagen (HTTP ${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

export async function establishSession(): Promise<void> {
  const prefix = "#bootstrap=";
  if (!location.hash.startsWith(prefix)) return;
  const secret = decodeURIComponent(location.hash.slice(prefix.length));
  await post<{ authenticated: true }>("/api/session/bootstrap", { secret });
  history.replaceState(null, "", location.pathname + location.search);
}

export const api = {
  authStatus: (request: Pick<ProjectRequest, "environment"> = {}) =>
    post<AuthStatusResult>("/api/auth/status", request),
  plan: (request: PlanRequest = {}) => post<PlanResult>("/api/plan", request),
  coverage: (request: CoverageRequest = {}) => post<CoverageResult>("/api/coverage", request),
  state: (request: ProjectRequest = {}) => post<StateListResult>("/api/state", request),
  prepareApply: (request: ApplyRequest = {}) => post<PreparedApply>("/api/apply/prepare", request),
  executeApply: (id: string, proof?: ConfirmationProof) =>
    post<ApplyResult>(`/api/apply/${encodeURIComponent(id)}/execute`, { proof }),
};

export interface OperationEventStream {
  finished: Promise<OperationEvent>;
  close(): void;
}

/** Subscribe before execution; the server also replays bounded history if execution wins the race. */
export function watchOperation(id: string, onEvent: (event: OperationEvent) => void): OperationEventStream {
  const source = new EventSource(`/api/operations/${encodeURIComponent(id)}/events`);
  let settled = false;
  let resolveFinished!: (event: OperationEvent) => void;
  let rejectFinished!: (error: Error) => void;
  const finished = new Promise<OperationEvent>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });
  source.addEventListener("operation", (message) => {
    try {
      const event = JSON.parse((message as MessageEvent<string>).data) as OperationEvent;
      onEvent(event);
      if (event.type === "operation-completed" || event.type === "operation-failed") {
        settled = true;
        source.close();
        resolveFinished(event);
      }
    } catch (caught) {
      settled = true;
      source.close();
      rejectFinished(caught instanceof Error ? caught : new Error(String(caught)));
    }
  });
  source.onerror = () => {
    if (!settled) {
      settled = true;
      rejectFinished(new Error("Der Fortschrittskanal wurde unterbrochen."));
    }
    source.close();
  };
  return { finished, close: () => source.close() };
}
