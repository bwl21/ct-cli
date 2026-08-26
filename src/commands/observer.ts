import type { OperationEvent } from "../application/contracts.js";
import type { OperationObserver } from "../application/ports.js";
import { error, info, success, warn } from "../ui.js";

/**
 * The terminal adapter for operation events.
 *
 * Operations report progress as it happens rather than returning it in an array the command
 * prints afterwards — an array is lost the moment the operation throws, which is exactly when a
 * half-finished irreversible run most needs to say what it already did (#156 review).
 * Phase and per-resource events stay silent here; commands that want them can compose their own.
 */
export function cliObserver(): OperationObserver {
  return {
    emit(event: OperationEvent): void {
      switch (event.type) {
        case "backup-written":
          info(`Backup written: ${event.path}`);
          return;
        case "warning":
          warn(event.warning.message);
          return;
        case "outcome":
          if (event.outcome.status === "ok") success(event.outcome.message);
          else if (event.outcome.status === "failed") error(event.outcome.message);
          else info(event.outcome.message);
          return;
        default:
          return;
      }
    },
  };
}
