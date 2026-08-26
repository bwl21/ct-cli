import type { JsonValue } from "./contracts.js";

export const APPLICATION_ERROR_CODES = [
  "ENVIRONMENT_REQUIRED",
  "PLAN_INCOMPLETE",
  "AUTH_REQUIRED",
  "HOST_MISMATCH",
  "PROTECTED_ENV_CONFIRMATION_REQUIRED",
  "PLAN_CONFIRMATION_MISMATCH",
  "PREVENT_DESTROY",
  "DESTROY_BACKUP_FAILED",
  "OPERATION_EXPIRED",
  "OPERATION_ALREADY_USED",
  "MUTATION_BUSY",
] as const;

export type ApplicationErrorCode = (typeof APPLICATION_ERROR_CODES)[number];

/** Stable application error translated independently by CLI, HTTP and UI adapters. */
export class CtApplicationError extends Error {
  readonly code: ApplicationErrorCode;
  readonly details?: Record<string, JsonValue>;

  constructor(
    code: ApplicationErrorCode,
    message: string,
    options: { details?: Record<string, JsonValue>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CtApplicationError";
    this.code = code;
    this.details = options.details;
  }

  toJSON(): { code: ApplicationErrorCode; message: string; details?: Record<string, JsonValue> } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}
