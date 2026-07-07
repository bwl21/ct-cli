import { describe, it, expect, vi, afterEach } from "vitest";
import { CtClient, CtApiError } from "../src/api/ctClient.js";

function jsonResponse(body: unknown, init: ResponseInit & { setCookie?: string } = {}): Response {
  const headers = new Headers(init.headers);
  if (init.setCookie) {
    headers.append("set-cookie", init.setCookie);
  }
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CtClient", () => {
  it("performs the login-token → cookie → csrf handshake", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ data: { id: 7, firstName: "Ada" } }, { setCookie: "ChurchTools_ct_eqrm=abc; Path=/" }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-123" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: "https://eqrm.church.tools" });
    const me = await client.authenticate("tok");

    expect(me).toEqual({ id: 7, firstName: "Ada" });
    const firstUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(firstUrl)).toContain("/api/whoami?login_token=tok");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/csrftoken");
  });

  it("refuses requests before authentication", async () => {
    const client = new CtClient({ host: "https://eqrm.church.tools" });
    await expect(client.get("/campuses")).rejects.toBeInstanceOf(CtApiError);
  });

  it("sends the CSRF header on writes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 1 } }, { setCookie: "s=1; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-xyz" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 99 } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: "https://eqrm.church.tools" });
    await client.authenticate("tok");
    await client.request("POST", "/campuses", { name: "Mainz" });

    const writeInit = fetchMock.mock.calls[2]?.[1];
    const headers = new Headers(writeInit?.headers);
    expect(headers.get("CSRF-Token")).toBe("csrf-xyz");
    expect(headers.get("Cookie")).toContain("s=1");
  });
});
