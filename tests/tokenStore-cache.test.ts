import { describe, it, expect, vi, beforeEach } from "vitest";

// A single command run resolves the host (resolveConfig → readStoredHost) AND the token
// (authedSession → readCredentials), each reaching for the same Keychain entry. Without memoization
// that spawns `security find-generic-password` up to 3× (and prompts to unlock a locked Keychain
// every time). Mock the platform to macOS and the `security` spawn so we can count the reads.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:os", () => ({ platform: () => "darwin" }));

import { readCredentials, readStoredHost, resetKeychainCache } from "../src/auth/tokenStore.js";

beforeEach(() => {
  execFileMock.mockReset();
  resetKeychainCache();
  // promisify(execFile) over this mock resolves with whatever we pass as the callback's value arg,
  // so return the { stdout } shape the real execFile promise yields.
  execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (e: unknown, v: unknown) => void) =>
    cb(null, { stdout: '{"host":"https://x.church.tools","token":"tok"}', stderr: "" }),
  );
});

describe("keychain read is memoized per process (#35 item 4)", () => {
  it("spawns `security` only once across multiple credential reads", async () => {
    const a = await readCredentials();
    const host = await readStoredHost();
    const b = await readCredentials();
    expect(a).toEqual({ host: "https://x.church.tools", token: "tok" });
    expect(b).toEqual(a);
    expect(host).toBe("https://x.church.tools");
    expect(execFileMock).toHaveBeenCalledTimes(1); // memoized: 3 logical reads → 1 spawn
  });

  it("resetKeychainCache forces the next read to re-spawn (write invalidation seam)", async () => {
    await readCredentials();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    resetKeychainCache();
    await readCredentials();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
