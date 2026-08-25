import type { OperationEvent, OperationName } from "../application/contracts.js";
import type { OperationObserver } from "../application/ports.js";

interface EventRecord {
  events: OperationEvent[];
  finished: boolean;
  listeners: Set<(event: OperationEvent, finished: boolean) => void>;
}

/** Bounded, process-local event history behind the SSE projection. */
export class OperationEventStore {
  private readonly records = new Map<string, EventRecord>();

  open(id: string): void {
    this.records.set(id, { events: [], finished: false, listeners: new Set() });
    while (this.records.size > 100) this.records.delete(this.records.keys().next().value!);
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  observer(id: string): OperationObserver {
    return { emit: (event) => this.emit(id, event) };
  }

  complete(id: string, operation: OperationName): void {
    this.emit(id, { type: "operation-completed", operation }, true);
  }

  fail(id: string, operation: OperationName, code: string): void {
    this.emit(id, { type: "operation-failed", operation, code }, true);
  }

  listen(id: string, listener: (event: OperationEvent, finished: boolean) => void): () => void {
    const record = this.records.get(id);
    if (!record) return () => undefined;
    for (const event of record.events) listener(event, record.finished && event === record.events.at(-1));
    if (!record.finished) record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  private emit(id: string, event: OperationEvent, finished = false): void {
    const record = this.records.get(id);
    if (!record || record.finished) return;
    record.events.push(event);
    record.finished = finished;
    for (const listener of record.listeners) listener(event, finished);
    if (finished) record.listeners.clear();
  }
}
