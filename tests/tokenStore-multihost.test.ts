import { describe, it, expect, vi, beforeEach } from "vitest";

// Multi-host token store (#22 item 2): credentials live under a per-host Keychain account, with a
// backward-compatible fallback to the legacy single "credentials" blob. Mock macOS + the `security`
// spawn so we can model what each account currently holds and assert the read/fallback behaviour.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:os", () => ({ platform: () => "darwin" }));

import {
  readCredentials,
  readStoredHost,
  storeCredentials,
  resetKeychainCache,
} from "../src/auth/tokenStore.js";

const DEV = "https://mychurch-dev.church.tools";
const PROD = "https://mychurch.church.tools";

/** Model a keychain as account → stored blob; wire the `security` CLI mock to read/write it. */
function mockKeychain(store: Map<string, string>): void {
  execFileMock.mockImplementation(
    (_cmd: string, args: string[], cb: (e: unknown, v: unknown) => void) => {
      const sub = args[0];
      const account = args[args.indexOf("-a") + 1]!;
      if (sub === "find-generic-password") {
        const val = store.get(account);
        if (val === undefined) return cb(new Error("not found"), null);
        return cb(null, { stdout: val, stderr: "" });
      }
      if (sub === "add-generic-password") {
        store.set(account, args[args.indexOf("-w") + 1]!);
        return cb(null, { stdout: "", stderr: "" });
      }
      if (sub === "delete-generic-password") {
        store.delete(account);
        return cb(null, { stdout: "", stderr: "" });
      }
      return cb(new Error(`unexpected security subcommand ${sub}`), null);
    },
  );
}

beforeEach(() => {
  execFileMock.mockReset();
  resetKeychainCache();
});

describe("multi-host token store", () => {
  it("stores credentials under a per-host account and reads them back by host", async () => {
    const store = new Map<string, string>();
    mockKeychain(store);

    await storeCredentials({ host: DEV, token: "dev-tok" });
    await storeCredentials({ host: PROD, token: "prod-tok" });

    expect(await readCredentials(DEV)).toEqual({ host: DEV, token: "dev-tok" });
    expect(await readCredentials(PROD)).toEqual({ host: PROD, token: "prod-tok" });
    // The host-keyed account exists for each host.
    expect(store.has(DEV)).toBe(true);
    expect(store.has(PROD)).toBe(true);
  });

  it("falls back to the legacy single blob when its host matches the requested host", async () => {
    // Simulate a user who logged in BEFORE the multi-host change: only the legacy account exists.
    const store = new Map<string, string>([
      ["credentials", JSON.stringify({ host: PROD, token: "legacy-tok" })],
    ]);
    mockKeychain(store);

    expect(await readCredentials(PROD)).toEqual({ host: PROD, token: "legacy-tok" });
  });

  it("does NOT return the legacy blob for a different host (no cross-host leak)", async () => {
    const store = new Map<string, string>([
      ["credentials", JSON.stringify({ host: PROD, token: "legacy-tok" })],
    ]);
    mockKeychain(store);

    expect(await readCredentials(DEV)).toBeNull();
  });

  it("readStoredHost (no host) returns the default/last-login blob for the single-host path", async () => {
    const store = new Map<string, string>();
    mockKeychain(store);
    await storeCredentials({ host: PROD, token: "prod-tok" });
    expect(await readStoredHost()).toBe(PROD);
  });

  it("prefers the host-keyed account over the legacy blob when both exist", async () => {
    const store = new Map<string, string>([
      ["credentials", JSON.stringify({ host: DEV, token: "legacy-dev" })],
      [DEV, JSON.stringify({ host: DEV, token: "keyed-dev" })],
    ]);
    mockKeychain(store);
    expect(await readCredentials(DEV)).toEqual({ host: DEV, token: "keyed-dev" });
  });
});
