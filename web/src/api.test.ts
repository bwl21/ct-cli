import { afterEach, describe, expect, it, vi } from "vitest";
import { api, watchOperation } from "./api.js";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, value: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeEventSource.last = null;
});

describe("web API adapter", () => {
  it("loads the server-owned workspace without sending browser paths", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          process: { name: "process", configPath: "ct.config.ts", environmentsPath: "ct.envs.json" },
          environments: [],
          selectedEnvironment: null,
          requiresEnvironment: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await api.workspace();

    expect(fetch).toHaveBeenCalledWith(
      "/api/workspace",
      expect.objectContaining({ body: "{}", method: "POST" }),
    );
  });

  it("translates prepare and execute without adding project paths", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "apply-1", confirmation: { type: "yes" } }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ operation: "apply" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await api.prepareApply({ environment: "prod", refresh: true });
    await api.executeApply("apply-1", { type: "environment", value: "prod" });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/apply/prepare",
      expect.objectContaining({ body: JSON.stringify({ environment: "prod", refresh: true }) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/apply/apply-1/execute",
      expect.objectContaining({
        body: JSON.stringify({ proof: { type: "environment", value: "prod" } }),
      }),
    );
  });

  it("streams shared events and closes on the terminal event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const seen: unknown[] = [];
    const stream = watchOperation("apply-1", (event) => seen.push(event));
    const source = FakeEventSource.last!;
    expect(source.url).toBe("/api/operations/apply-1/events");

    source.emit("operation", { type: "phase-started", phase: "backup" });
    source.emit("operation", { type: "operation-completed", operation: "apply" });

    await expect(stream.finished).resolves.toEqual({
      type: "operation-completed",
      operation: "apply",
    });
    expect(seen).toEqual([
      { type: "phase-started", phase: "backup" },
      { type: "operation-completed", operation: "apply" },
    ]);
    expect(source.closed).toBe(true);
  });
});
