import { randomUUID } from "node:crypto";
import { CtApplicationError } from "./errors.js";
import type { Clock, IdGenerator, MutationLock } from "./ports.js";
import { systemClock } from "./ports.js";

interface StoredOperation<T> {
  value: T;
  expiresAt: Date;
  used: boolean;
}

export class PreparedOperationStore<T> {
  private readonly operations = new Map<string, StoredOperation<T>>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly ids: IdGenerator = { nextId: () => randomUUID() },
  ) {}

  put(value: T, ttlMs: number): { id: string; expiresAt: Date } {
    const id = this.ids.nextId();
    const expiresAt = new Date(this.clock.now().getTime() + ttlMs);
    this.operations.set(id, { value, expiresAt, used: false });
    return { id, expiresAt };
  }

  peek(id: string): T {
    const entry = this.getEntry(id);
    return entry.value;
  }

  take(id: string): T {
    const entry = this.getEntry(id);
    entry.used = true;
    return entry.value;
  }

  private getEntry(id: string): StoredOperation<T> {
    const entry = this.operations.get(id);
    if (!entry || entry.used) {
      throw new CtApplicationError(
        "OPERATION_ALREADY_USED",
        "Prepared operation is unknown or already used.",
      );
    }
    if (entry.expiresAt.getTime() <= this.clock.now().getTime()) {
      throw new CtApplicationError("OPERATION_EXPIRED", "Prepared operation has expired. Prepare it again.");
    }
    return entry;
  }
}

/** Process-local, fail-fast lock. A later HTTP adapter can share this instance across requests. */
export class InMemoryMutationLock implements MutationLock {
  private readonly active = new Set<string>();

  async runExclusive<T>(statePath: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(statePath)) {
      throw new CtApplicationError("MUTATION_BUSY", `Another mutation is already using ${statePath}.`);
    }
    this.active.add(statePath);
    try {
      return await operation();
    } finally {
      this.active.delete(statePath);
    }
  }
}
