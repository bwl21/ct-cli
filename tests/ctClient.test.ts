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

    const client = new CtClient({ host: "https://mychurch.church.tools" });
    const me = await client.authenticate("tok");

    expect(me).toEqual({ id: 7, firstName: "Ada" });
    const firstUrl = fetchMock.mock.calls[0]?.[0];
    expect(String(firstUrl)).toContain("/api/whoami?login_token=tok");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/csrftoken");
  });

  it("refuses requests before authentication", async () => {
    const client = new CtClient({ host: "https://mychurch.church.tools" });
    await expect(client.get("/campuses")).rejects.toBeInstanceOf(CtApiError);
  });

  it("sends the CSRF header on writes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 1 } }, { setCookie: "s=1; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf-xyz" }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 99 } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CtClient({ host: "https://mychurch.church.tools" });
    await client.authenticate("tok");
    await client.request("POST", "/campuses", { name: "Mainz" });

    const writeInit = fetchMock.mock.calls[2]?.[1];
    const headers = new Headers(writeInit?.headers);
    expect(headers.get("CSRF-Token")).toBe("csrf-xyz");
    expect(headers.get("Cookie")).toContain("s=1");
  });

  async function authedClient(): Promise<{ client: CtClient; fetchMock: ReturnType<typeof vi.fn<typeof fetch>> }> {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ data: { id: 1 } }, { setCookie: "s=1; Path=/" }))
      .mockResolvedValueOnce(jsonResponse({ data: "csrf" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CtClient({ host: "https://mychurch.church.tools" });
    await client.authenticate("tok");
    return { client, fetchMock };
  }

  it("assertMinVersion passes on a supported instance and refuses an old one", async () => {
    const { client, fetchMock } = await authedClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { version: "3.123.0" } }));
    await expect(client.assertMinVersion()).resolves.toBeUndefined();

    const { client: old, fetchMock: oldFetch } = await authedClient();
    oldFetch.mockResolvedValueOnce(jsonResponse({ data: { version: "3.95.0" } }));
    await expect(old.assertMinVersion()).rejects.toThrow(/3\.95\.0 is below the required minimum/);
  });

  it("assertMinVersion fetches /info only once (cached)", async () => {
    const { client, fetchMock } = await authedClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { version: "3.123.0" } }));
    await client.assertMinVersion();
    await client.assertMinVersion();
    const infoCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/info"));
    expect(infoCalls.length).toBe(1);
  });

  it("returns undefined for an empty 2xx body instead of throwing a raw SyntaxError", async () => {
    const { client, fetchMock } = await authedClient();
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));
    await expect(client.request("DELETE", "/groups/1/parents/2")).resolves.toBeUndefined();
  });

  it("wraps a non-JSON 2xx body in a CtApiError naming method + path", async () => {
    const { client, fetchMock } = await authedClient();
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 200 }));
    await expect(client.request("PUT", "/campuses/0")).rejects.toMatchObject({
      name: "CtApiError",
      message: expect.stringContaining("PUT /campuses/0"),
    });
  });

  describe("getAll (#50)", () => {
    it("auto-paginates until lastPage is reached, concatenating every page", async () => {
      const { client, fetchMock } = await authedClient();
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ id: 1 }, { id: 2 }],
            meta: { pagination: { total: 3, current: 1, lastPage: 2, limit: 2 } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            data: [{ id: 3 }],
            meta: { pagination: { total: 3, current: 2, lastPage: 2, limit: 2 } },
          }),
        );

      const result = await client.getAll("/groups", { limit: 2 });

      expect(result.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(result.meta?.pagination).toMatchObject({ total: 3, current: 2, lastPage: 2 });
      // calls 0-1 are the auth handshake (whoami + csrftoken); 2-3 are the two pages.
      expect(String(fetchMock.mock.calls[2]?.[0])).toContain("page=1");
      expect(String(fetchMock.mock.calls[2]?.[0])).toContain("limit=2");
      expect(String(fetchMock.mock.calls[3]?.[0])).toContain("page=2");
    });

    it("stops after a single page when the response carries no pagination meta", async () => {
      const { client, fetchMock } = await authedClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 1 }] }));

      const result = await client.getAll("/campuses");

      expect(result.data).toEqual([{ id: 1 }]);
      expect(fetchMock).toHaveBeenCalledTimes(3); // 2 auth + 1 page, no second page requested
    });

    it("defaults the per-page limit to 100", async () => {
      const { client, fetchMock } = await authedClient();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: [], meta: { pagination: { total: 0, current: 1, lastPage: 1, limit: 100 } } }),
      );

      await client.getAll("/groups");

      expect(String(fetchMock.mock.calls[2]?.[0])).toContain("limit=100");
    });

    it("stops when a page comes back empty even if lastPage claims more", async () => {
      const { client, fetchMock } = await authedClient();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ data: [], meta: { pagination: { total: 3, current: 1, lastPage: 2, limit: 2 } } }),
      );

      const result = await client.getAll("/groups", { limit: 2 });

      expect(result.data).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(3); // does not spin forever on a degenerate response
    });

    it("propagates a CtApiError with status + body from a failing page", async () => {
      const { client, fetchMock } = await authedClient();
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ["limit exceeds max of 100"] }), { status: 400 }),
      );

      await expect(client.getAll("/groups", { limit: 500 })).rejects.toMatchObject({
        name: "CtApiError",
        status: 400,
        body: { errors: ["limit exceeds max of 100"] },
      });
    });
  });
});
