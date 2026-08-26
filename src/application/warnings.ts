import type { CtWarning } from "./contracts.js";
import type { OperationObserver } from "./ports.js";

/** Collect a warning and report it in the same breath. */
export type WarningSink = (warning: CtWarning) => void;

/**
 * Build a sink that appends to `warnings` AND emits the warning immediately.
 *
 * A warnings array that is only drained after the operation resolves is discarded whenever the
 * operation throws — which is precisely when a half-finished adoption most needs to say what it
 * silently left out (#156 review). Emitting as we go keeps the returned array intact for the
 * structured result while making the operator hear about it either way.
 */
export function warningSink(warnings: CtWarning[], observer: OperationObserver): WarningSink {
  return (warning) => {
    warnings.push(warning);
    observer.emit({ type: "warning", warning });
  };
}
