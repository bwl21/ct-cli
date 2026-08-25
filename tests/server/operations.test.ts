import { describe, expect, it, vi } from "vitest";
import { createServerOperationCatalog } from "../../src/server/operations.js";
import { OperationEventStore } from "../../src/server/operation-store.js";

describe("server operation catalog", () => {
  it("shares one state-file lock between apply and destroy", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const executePreparedApply = vi.fn(async (_prepared, _proof, dependencies) =>
      dependencies.lock.runExclusive("/project/state.json", async () => {
        entered();
        await held;
        return { operation: "apply" };
      }),
    );
    const executePreparedDestroy = vi.fn(async (_prepared, _proof, dependencies) =>
      dependencies.lock.runExclusive("/project/state.json", async () => ({ operation: "destroy" })),
    );
    const events = new OperationEventStore();
    events.open("apply-1");
    events.open("destroy-1");
    const catalog = createServerOperationCatalog({
      events,
      core: { executePreparedApply, executePreparedDestroy } as never,
    });

    const applying = catalog.executeApply("apply-1", { type: "yes" });
    await started;
    await expect(catalog.executeDestroy("destroy-1", { type: "yes" })).rejects.toMatchObject({
      code: "MUTATION_BUSY",
    });
    release();
    await applying;

    const applyEvents: unknown[] = [];
    const destroyEvents: unknown[] = [];
    events.listen("apply-1", (event) => applyEvents.push(event));
    events.listen("destroy-1", (event) => destroyEvents.push(event));
    expect(applyEvents).toContainEqual({ type: "operation-completed", operation: "apply" });
    expect(destroyEvents).toContainEqual({
      type: "operation-failed",
      operation: "destroy",
      code: "MUTATION_BUSY",
    });
  });
});
