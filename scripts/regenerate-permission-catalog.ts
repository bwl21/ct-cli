/**
 * Regenerate `src/permissions/catalog.json` from a live ChurchTools instance (#25).
 *
 * The name↔authId catalog is NOT exposed by the REST API — it is only served to the permission
 * editor via the legacy AJAX endpoint. This script logs in with a login token, calls that endpoint,
 * flattens the master-data `auth_table` into the catalog's exact schema, stamps it with the
 * instance's CT version (for `ct plan`'s staleness warning), and writes the file.
 *
 *   Usage:
 *     CT_HOST=https://your.church.tools CT_LOGINTOKEN=<token> npm run regenerate:permission-catalog
 *
 *   - CT_HOST        the instance base URL (same value `ct` uses).
 *   - CT_LOGINTOKEN  a login token for a user who can open the permission editor
 *                    (Settings → Permissions). Get it from the CT admin, `ct` credentials,
 *                    or your browser session.
 *
 * This is a DEV script (run via tsx, a devDependency) — it is never bundled into `dist/`, and it is
 * the only code that talks to the legacy `churchauth/ajax` surface. It performs a single read; it
 * never writes to the instance. Review the git diff on `catalog.json` before committing.
 *
 * Source shape (see src/permissions/README.md):
 *   POST /index.php?q=churchauth/ajax   body: func=getMasterData
 *   → { data: { auth_table: { <module>: { <right>: { id, datenfeld, bezeichnung, isRevocable, … } } } } }
 *
 * Mapping to a catalog entry `"<module>:<right>"`:
 *   authId     ← id
 *   scopeField ← datenfeld  (empty/falsy → null)
 *   revocable  ← !!isRevocable
 *   desc       ← bezeichnung ?? ""
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

interface RawRight {
  id: number;
  datenfeld?: string | null;
  bezeichnung?: string | null;
  isRevocable?: boolean | number;
  [k: string]: unknown;
}
interface MasterData {
  data?: { auth_table?: Record<string, Record<string, RawRight>> };
  auth_table?: Record<string, Record<string, RawRight>>;
}
interface CatalogEntry {
  authId: number;
  scopeField: string | null;
  revocable: boolean;
  desc: string;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}. See the header of this script for usage.`);
  return v;
}

/** Parse a `Set-Cookie` header list into a single `Cookie` request-header value. */
function cookieHeader(res: Response): string {
  // Node's fetch exposes multiple Set-Cookie via getSetCookie(); fall back to the folded header.
  const raw =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie") as string] : []);
  return raw.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
}

async function main(): Promise<void> {
  const host = requireEnv("CT_HOST").replace(/\/+$/, "");
  const token = requireEnv("CT_LOGINTOKEN");

  // 1. Log in (login-token handshake) to obtain the session cookie the legacy endpoint needs.
  const whoami = await fetch(`${host}/api/whoami?login_token=${encodeURIComponent(token)}`, {
    headers: { Accept: "application/json" },
  });
  if (!whoami.ok) throw new Error(`Login failed (whoami): HTTP ${whoami.status}`);
  const cookie = cookieHeader(whoami);
  if (!cookie) throw new Error("Login succeeded but no session cookie was returned.");

  // 2. Read the instance CT version (for the catalog's provenance stamp).
  const infoRes = await fetch(`${host}/api/info`, { headers: { Accept: "application/json", Cookie: cookie } });
  const infoBody = (await infoRes.json().catch(() => ({}))) as { data?: { version?: string }; version?: string };
  const ctVersion = infoBody.data?.version ?? infoBody.version ?? "unknown";

  // 3. Fetch the permission master data from the legacy AJAX endpoint.
  const res = await fetch(`${host}/index.php?q=churchauth/ajax`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "func=getMasterData",
  });
  if (!res.ok) throw new Error(`getMasterData failed: HTTP ${res.status}`);
  const master = (await res.json()) as MasterData;
  const authTable = master.data?.auth_table ?? master.auth_table;
  if (!authTable || typeof authTable !== "object") {
    throw new Error("Unexpected response: no data.auth_table in getMasterData. Is the endpoint/shape unchanged?");
  }

  // 4. Flatten `auth_table[module][right]` → `"module:right" → CatalogEntry`, preserving iteration order.
  const rights: Record<string, CatalogEntry> = {};
  for (const [moduleName, moduleRights] of Object.entries(authTable)) {
    for (const [rightName, raw] of Object.entries(moduleRights)) {
      const field = raw.datenfeld;
      rights[`${moduleName}:${rightName}`] = {
        authId: raw.id,
        scopeField: field && String(field).length > 0 ? String(field) : null,
        revocable: Boolean(raw.isRevocable),
        desc: raw.bezeichnung ? String(raw.bezeichnung) : "",
      };
    }
  }

  const rightCount = Object.keys(rights).length;
  const host_ = host.replace(/^https?:\/\//, "");
  const catalog = {
    // Reserved provenance key (split off by src/permissions/catalog.ts — never seen as a right).
    $meta: {
      capturedFrom: host_,
      ctVersion,
      capturedAt: new Date().toISOString().slice(0, 10),
      rightCount,
      source: "POST /index.php?q=churchauth/ajax  func=getMasterData",
      regenerate: "npm run regenerate:permission-catalog (see src/permissions/README.md)",
    },
    ...rights,
  };

  const outPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "permissions", "catalog.json");
  writeFileSync(outPath, `${JSON.stringify(catalog, null, 1)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${outPath}\n  ${rightCount} rights · CT ${ctVersion} · ${host_}\n` +
      `Review the diff (git diff src/permissions/catalog.json) before committing.\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
