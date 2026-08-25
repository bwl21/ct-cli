import type { OperationEvent } from "./contracts.js";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(): string;
}

export interface OperationObserver {
  emit(event: OperationEvent): void;
}

/** Serialize mutations that target the same state file. */
export interface MutationLock {
  runExclusive<T>(statePath: string, operation: () => Promise<T>): Promise<T>;
}

export const systemClock: Clock = { now: () => new Date() };
export const noopObserver: OperationObserver = { emit: () => undefined };
