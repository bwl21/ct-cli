/**
 * Layer 0 + Layer 1: authenticated ChurchTools API access.
 *
 * ChurchTools' personal login token authenticates via a session handshake, NOT
 * an `Authorization` header (which yields a null CSRF token for this token
 * class and breaks writes). The proven flow for this instance is:
 *
 *   1. GET /api/whoami?login_token=<token>  → sets the session cookie
 *   2. GET /api/csrftoken                   → returns the CSRF token
 *   3. every request sends the cookie; every write sends `CSRF-Token: <token>`
 *
 * Phase 0 (#2) confirms this handshake against a live token. Once the typed
 * client is generated (`npm run generate:client`), the hand-written `request`
 * here can be swapped for `openapi-fetch` while keeping this class's surface.
 */
import { type CtConfig } from "../config.js";
import { fetchWithRetry } from "./http.js";
import { meetsMinVersion, MIN_CT_VERSION, type CtInfo } from "./version.js";

export interface WhoAmI {
  id: number;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export class CtApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "CtApiError";
  }
}

type Json = Record<string, unknown>;

export class CtClient {
  private cookie: string | null = null;
  private csrfToken: string | null = null;
  private ctVersion: string | null = null;

  constructor(private readonly config: CtConfig) {}

  get host(): string {
    return this.config.host;
  }

  /**
   * Hard-fail if the ChurchTools instance is below the minimum version the CLI
   * requires (group hierarchy / metadata CRUD need v3.96+). One `/info` GET,
   * cached so repeated calls in a session cost nothing. plan/apply/destroy call
   * this via {@link authedSession} — a half-applied structure from a stale
   * instance is exactly what the gate exists to prevent.
   */
  async assertMinVersion(min: string = MIN_CT_VERSION): Promise<void> {
    if (this.ctVersion === null) {
      const info = await this.get<CtInfo>("/info");
      this.ctVersion = info?.version ?? "";
    }
    const version = this.ctVersion;
    if (!version) {
      throw new CtApiError(
        `ChurchTools did not report a version (GET /info) — cannot verify the required minimum ${min}.`,
        0,
        null,
      );
    }
    if (!meetsMinVersion(version, min)) {
      throw new Error(
        `ChurchTools ${version} is below the required minimum ${min}. ` +
          `Upgrade ChurchTools before running plan/apply/destroy.`,
      );
    }
  }

  /** Run the login-token handshake and cache the session cookie + CSRF token. */
  async authenticate(loginToken: string): Promise<WhoAmI> {
    // The token rides as a URL query param (it lands in the server's access logs). This is
    // unavoidable for this token class: the handshake above is documented to require the
    // `login_token` query param — an `Authorization` header yields a null CSRF token and breaks
    // writes. The token↔host binding enforced in `authedSession` (issue #30) makes this safe by
    // guaranteeing the token is only ever sent to the host it was captured against.
    const url = `${this.config.host}/api/whoami?login_token=${encodeURIComponent(loginToken)}`;
    const res = await fetchWithRetry(
      url,
      { headers: { Accept: "application/json" } },
      { isIdempotent: true },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`Login failed (whoami)`, res.status, await safeBody(res));
    }
    if (!this.cookie) {
      throw new CtApiError("Login succeeded but no session cookie was returned", res.status, null);
    }
    await this.refreshCsrfToken();
    // Same tolerant unwrap as request(): prefer `.data`, but fall back to the raw body if the
    // envelope is absent, so authenticate and request() agree on the shape.
    const body = (await res.json()) as { data?: WhoAmI };
    return (body.data ?? body) as WhoAmI;
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async request<T = unknown>(method: string, path: string, body?: Json): Promise<T> {
    if (!this.cookie) {
      throw new CtApiError("Not authenticated — run `ct auth login` first", 401, null);
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      Cookie: this.cookie,
    };
    if (method !== "GET" && method !== "HEAD") {
      if (!this.csrfToken) {
        await this.refreshCsrfToken();
      }
      headers["CSRF-Token"] = this.csrfToken ?? "";
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const res = await fetchWithRetry(
      `${this.config.host}/api${path}`,
      {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      { isIdempotent: method === "GET" || method === "HEAD" },
    );
    this.captureCookie(res);
    if (!res.ok) {
      throw new CtApiError(`${method} ${path} failed`, res.status, await safeBody(res));
    }
    if (res.status === 204) {
      return undefined as T;
    }
    // Any 2xx may carry an empty or non-JSON body (DELETEs commonly do). A bare
    // res.json() there throws a raw SyntaxError naming no request. Read the text
    // first: empty → undefined; unparseable → a CtApiError that names method+path.
    const text = await res.text();
    if (text.trim() === "") {
      return undefined as T;
    }
    let parsed: { data?: T };
    try {
      parsed = JSON.parse(text) as { data?: T };
    } catch {
      throw new CtApiError(`${method} ${path} returned a non-JSON body`, res.status, text);
    }
    return (parsed.data ?? parsed) as T;
  }

  private async refreshCsrfToken(): Promise<void> {
    // A plain authenticated GET: it rides the session cookie and GET skips the CSRF branch in
    // request(), so this cannot recurse — and it reuses request()'s envelope unwrap + guarded 2xx
    // parsing instead of duplicating the bootstrap fetch here. Callers only reach this once a cookie
    // exists (authenticate sets it; request()'s write path guards on it), so the old empty-cookie
    // early-return is unreachable and dropped.
    this.csrfToken = await this.get<string>("/csrftoken");
  }

  /** Merge any Set-Cookie values into the stored cookie header. */
  private captureCookie(res: Response): void {
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length === 0) {
      return;
    }
    const jar = new Map<string, string>(
      (this.cookie ?? "")
        .split("; ")
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf("=");
          return [pair.slice(0, eq), pair.slice(eq + 1)] as [string, string];
        }),
    );
    for (const raw of setCookies) {
      const first = raw.split(";", 1)[0] ?? "";
      const eq = first.indexOf("=");
      if (eq > 0) {
        jar.set(first.slice(0, eq), first.slice(eq + 1));
      }
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function safeBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
