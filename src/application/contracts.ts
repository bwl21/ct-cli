/** JSON-compatible values used at the application/adapter boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type OperationName =
  "plan" | "apply" | "coverage" | "adopt" | "state" | "refresh" | "destroy" | "auth";

/** Common project selection accepted by CLI and, later, HTTP adapters. */
export interface ProjectRequest {
  cwd?: string;
  configPath?: string;
  statePath?: string;
  environment?: string;
}

/** Public, non-secret project context resolved before an operation starts. */
export interface ResolvedProjectInfo {
  cwd: string;
  /** Absolute paths used by operations. */
  configPath: string;
  statePath: string;
  environmentsPath: string;
  /** Effective flag/env/default spelling retained for byte-compatible CLI messages. */
  configDisplayPath: string;
  stateDisplayPath: string;
  environment: string | null;
  protected: boolean;
  host: string;
}

export interface CtWarning {
  code: string;
  message: string;
  details?: Record<string, JsonValue>;
}

export interface OperationResult<T> {
  operation: OperationName;
  project: ResolvedProjectInfo;
  value: T;
  warnings: CtWarning[];
}

export type OperationEvent =
  | { type: "phase-started"; phase: string }
  | { type: "resource-reading"; resourceType: string; key: string }
  | { type: "resource-created"; resourceType: string; key: string; id: number }
  | { type: "resource-updated"; resourceType: string; key: string; id: number }
  | { type: "backup-written"; path: string }
  | { type: "warning"; warning: CtWarning };
