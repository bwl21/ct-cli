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

// Most write bodies are objects, but a few (dynamic-group ruleset PUT, #77) are a single-element
// array — CT's array-envelope endpoints expect the request body itself to be an array, not an
// object wrapper.
type Json = Record<string, unknown> | unknown[];

/**
 * ChurchTools' list-endpoint pagination envelope, carried as `meta.pagination`
 * alongside `data`. Field names confirmed against the live API (#50): a page
 * is exhausted once `current >= lastPage`.
 */
export interface CtPagination {
  total?: number;
  current?: number;
  lastPage?: number;
  limit?: number;
  count?: number;
}

export interface CtMeta {
  pagination?: CtPagination;
  [key: string]: unknown;
}

export interface CtPage<T> {
  data: T[];
  meta?: CtMeta;
}

/** Hard stop so a malformed/adversarial pagination response can't loop forever. */
const MAX_PAGES = 1000;
const DEFAULT_PAGE_LIMIT = 100;

export class CtClient {
  private cookie: string | null = null;
  private csrfToken: string | null = null;
  private ctVersion: string | null = null;

  constructor(private readonly config: CtConfig) {}

  get host(): string {
    return this.config.host;
  }

  /**
   * The ChurchTools release this client is talking to, once known (populated by
   * {@link assertMinVersion} / any `/info` read, which every command runs via
   * `authedSession`). `null` until then. Surfaced in the `--env` plan header so a
   * per-env version gate is visible (#22), and used for the permission-catalog
   * staleness warning (#25) — no extra `/info` fetch, since the version is
   * already cached.
   */
  get version(): string | null {
    return this.ctVersion;
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
    const parsed = await this.requestEnvelope(method, path, body);
    if (parsed === undefined) {
      return undefined as T;
    }
    const envelope = parsed as { data?: T };
    return (envelope.data ?? envelope) as T;
  }

  /**
   * Fetch every page of a ChurchTools list endpoint and concatenate them, so
   * callers see the whole collection instead of just CT's default first page
   * (#50). CT caps `limit` at a per-endpoint maximum below 500 on real
   * instances, so this defaults to a conservative page size and pages via
   * `?page=N&limit=M` until `meta.pagination.current >= lastPage`. Endpoints
   * that don't return pagination meta (or return everything on page 1) fall
   * out after a single request.
   */
  async getAll<T = unknown>(path: string, options: { limit?: number } = {}): Promise<CtPage<T>> {
    const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
    const items: T[] = [];
    let meta: CtMeta | undefined;
    let page = 1;
    for (let i = 0; i < MAX_PAGES; i++) {
      const parsed = await this.requestEnvelope("GET", withPageParams(path, page, limit));
      if (parsed === undefined) {
        break;
      }
      const isArrayEnvelope = Array.isArray(parsed);
      const envelope = isArrayEnvelope ? undefined : (parsed as { data?: unknown; meta?: CtMeta });
      const pageData = isArrayEnvelope ? parsed : (envelope?.data ?? parsed);
      const pageItems = Array.isArray(pageData) ? (pageData as T[]) : [];
      items.push(...pageItems);
      const pageMeta = envelope?.meta;
      meta = pageMeta ?? meta;
      const pagination = pageMeta?.pagination;
      if (pageItems.length === 0 || !pagination || pagination.current === undefined || pagination.lastPage === undefined) {
        break;
      }
      if (pagination.current >= pagination.lastPage) {
        break;
      }
      page += 1;
    }
    return { data: items, meta };
  }

  /**
   * Shared fetch + parse for {@link request} and {@link getAll}: performs the
   * HTTP call, throws a status/body-carrying {@link CtApiError} on failure,
   * and returns the raw parsed JSON envelope (still carrying `data`/`meta`) —
   * or `undefined` for an empty 2xx body. Kept private so `request()`'s
   * `.data ?? envelope` unwrap stays the single source of truth for existing
   * callers (plan/apply/adopt) while `getAll()` gets at `meta` too.
   */
  private async requestEnvelope(method: string, path: string, body?: Json): Promise<unknown> {
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
      return undefined;
    }
    // Any 2xx may carry an empty or non-JSON body (DELETEs commonly do). A bare
    // res.json() there throws a raw SyntaxError naming no request. Read the text
    // first: empty → undefined; unparseable → a CtApiError that names method+path.
    const text = await res.text();
    if (text.trim() === "") {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CtApiError(`${method} ${path} returned a non-JSON body`, res.status, text);
    }
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

/** Append `page`/`limit` query params, respecting any query string the caller already has. */
function withPageParams(path: string, page: number, limit: number): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}page=${page}&limit=${limit}`;
}
