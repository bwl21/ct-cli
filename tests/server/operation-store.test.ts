import { describe, expect, it } from "vitest";
import type { OperationEvent } from "../../src/application/contracts.js";
import { OperationEventStore } from "../../src/server/operation-store.js";

describe("operation event store", () => {
  it("replays shared operation events and closes on completion", () => {
    const store = new OperationEventStore();
    store.open("run-1");
    store.observer("run-1").emit({ type: "phase-started", phase: "backup" });
    store.complete("run-1", "apply");

    const received: Array<{ event: OperationEvent; finished: boolean }> = [];
    store.listen("run-1", (event, finished) => received.push({ event, finished }));
    expect(received).toEqual([
      { event: { type: "phase-started", phase: "backup" }, finished: false },
      { event: { type: "operation-completed", operation: "apply" }, finished: true },
    ]);
  });

  it("publishes only a stable error code, not a caught message", () => {
    const store = new OperationEventStore();
    store.open("run-1");
    store.fail("run-1", "destroy", "MUTATION_BUSY");
    const events: OperationEvent[] = [];
    store.listen("run-1", (event) => events.push(event));
    expect(events).toEqual([{ type: "operation-failed", operation: "destroy", code: "MUTATION_BUSY" }]);
  });
});
