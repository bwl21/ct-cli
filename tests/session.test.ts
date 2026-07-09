import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the token store so the Keychain is never touched and we control the stored host/token.
const { readCredentials, readStoredHost } = vi.hoisted(() => ({
  readCredentials: vi.fn<() => Promise<{ host: string; token: string } | null>>(),
  readStoredHost: vi.fn<() => Promise<string | null>>(async () => null),
}));
vi.mock("../src/auth/tokenStore.js", () => ({ readCredentials, readStoredHost }));

import { authedSession } from "../src/api/session.js";

const savedHost = process.env.CT_HOST;
const savedToken = process.env.CT_LOGINTOKEN;

function restoreEnv(): void {
  if (savedHost === undefined) delete process.env.CT_HOST;
  else process.env.CT_HOST = savedHost;
  if (savedToken === undefined) delete process.env.CT_LOGINTOKEN;
  else process.env.CT_LOGINTOKEN = savedToken;
}

describe("authedSession host↔token binding (issue #30)", () => {
  beforeEach(() => {
    readCredentials.mockReset();
    delete process.env.CT_HOST;
    delete process.env.CT_LOGINTOKEN;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv();
  });

  it("refuses to send the stored token to a CT_HOST-overridden host — zero network calls", async () => {
    readCredentials.mockResolvedValue({ host: "https://prod.church.tools", token: "prod-secret" });
    process.env.CT_HOST = "https://staging.church.tools";
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(authedSession()).rejects.toThrow(
      /belongs to https:\/\/prod\.church\.tools.*resolved host is https:\/\/staging\.church\.tools/s,
    );
    // The token must never reach the wire: no fetch at all, so it can't land in a foreign log.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("names both hosts in the refusal so the user can act", async () => {
    readCredentials.mockResolvedValue({ host: "https://prod.church.tools", token: "prod-secret" });
    process.env.CT_HOST = "https://staging.church.tools";

    await expect(authedSession()).rejects.toThrow(
      /ct auth login --host https:\/\/staging\.church\.tools/,
    );
  });

  it("tolerates a trailing slash mismatch (host is normalized before comparison)", async () => {
    readCredentials.mockResolvedValue({ host: "https://prod.church.tools/", token: "prod-secret" });
    process.env.CT_HOST = "https://prod.church.tools";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "SESSION=abc" },
      }),
    );

    // Matching (modulo trailing slash) host proceeds to the network handshake.
    await authedSession().catch(() => {}); // csrf fetch may follow; we only assert the token was sent to the right host
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("https://prod.church.tools/api/whoami");
    expect(firstUrl).toContain("login_token=prod-secret");
  });

  it("skips the binding check for an explicit CT_LOGINTOKEN env token (no stored binding)", async () => {
    readCredentials.mockResolvedValue({ host: "https://prod.church.tools", token: "prod-secret" });
    process.env.CT_HOST = "https://staging.church.tools";
    process.env.CT_LOGINTOKEN = "explicit-env-token";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "SESSION=abc" },
      }),
    );

    await authedSession().catch(() => {});
    // The env token is sent to the env host; the stored prod token is never used.
    const firstUrl = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(firstUrl).toContain("https://staging.church.tools/api/whoami");
    expect(firstUrl).toContain("login_token=explicit-env-token");
  });
});
