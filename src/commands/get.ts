import { Command } from "commander";
import { authedSession } from "../api/session.js";
import {
  hasMorePages,
  hasOwnPageParams,
  withPageParams,
  type CtClient,
  type CtMeta,
} from "../api/ctClient.js";
import { prepareEnvHost } from "../env/context.js";
import { CATALOG } from "../permissions/catalog.js";
import { info, out, warn } from "../ui.js";

interface ResourceSpec {
  path: string;
  /**
   * Whether this endpoint returns a paged list (auto-paginate through every
   * page) vs a single object (`whoami`, `info`, the global permissions blob)
   * where paging params don't apply. Defaults to true.
   */
  paginated?: boolean;
}

/**
 * Read-only imperative queries — immediately useful before any declarative
 * engine exists. Resource → API path map. Paths confirmed against the live
 * spec by the Phase 0 spike (#2, CT 3.123.0); see docs/api-coverage.md.
 *
 * List endpoints are auto-paginated (#50): ChurchTools returns only its
 * default page (10 items) per request, so `ct get groups` on an instance with
 * 300+ groups silently returned just the first 10 before this fix.
 */
const RESOURCE_PATHS: Record<string, ResourceSpec> = {
  whoami: { path: "/whoami", paginated: false },
  info: { path: "/info", paginated: false },
  campuses: { path: "/campuses" },
  groups: { path: "/groups" },
  "group-hierarchies": { path: "/groups/hierarchies" },
  "group-types": { path: "/group/grouptypes" },
  "group-roles": { path: "/group/roles" },
  "age-groups": { path: "/group/agegroups" },
  "target-groups": { path: "/group/targetgroups" },
  "dynamic-groups": { path: "/dynamicgroups" },
  "relationship-types": { path: "/person/relationshiptypes" },
  // Bereiche/departments — the `cdb_bereich` permission scope dimension. READ-ONLY in ChurchTools
  // (GET only; no write verb exists), so this is the way to discover the names a
  // `scope: [{ department: "…" }]` reference resolves against. Never adoptable.
  departments: { path: "/departments" },
  // PERSON statuses — master data (the enumeration), never person records. The domain a `ct.status`
  // permission declaration hangs off, and an adoptable resource since #96.
  statuses: { path: "/statuses" },
  // Schema/DEFINITIONS only — never person records or field VALUES (#47/#48; see docs/handbuch/field-definitions.md).
  // The person master-data MODEL: sexes/titles/statuses/campuses plus the security-level enumeration
  // that churchdb permission scopes (cc_securitylevel) reference. Single object → unpaginated.
  "person-masterdata": { path: "/person/masterdata", paginated: false },
  // Unified data-field DEFINITION catalog (Datenfelder): person master-data fields AND group custom
  // fields in one list, discriminated per-row by `fieldCategory` (e.g. table `cdb_gruppe` = group).
  // Read-only: mutation is only via the legacy churchdb admin AJAX, not REST — see docs/handbuch/field-definitions.md.
  "data-fields": { path: "/dbfields" },
  permissions: { path: "/permissions/global", paginated: false },
};

export function getCommand(): Command {
  const cmd = new Command("get").description("Read structure resources from ChurchTools (JSON to stdout)");

  for (const [name, spec] of Object.entries(RESOURCE_PATHS)) {
    cmd
      .command(name)
      .description(`GET ${spec.path}`)
      .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
      .action(async (opts: { env?: string }) => {
        await prepareEnvHost(opts); // #22: wire the env's host/token before authenticating
        const { client } = await authedSession();
        if (spec.paginated === false) {
          out(await client.get(spec.path));
          return;
        }
        const { data, meta } = await client.getAll(spec.path);
        out(data);
        const total = meta?.pagination?.total;
        if (total !== undefined && total !== data.length) {
          info(`${data.length} of ${total} total`);
        } else {
          info(`${data.length} total`);
        }
      });
  }

  cmd
    .command("permissions-catalog")
    .description("List the static permission-name → authId catalog (for use in config `grants`)")
    .action(() => {
      for (const name of Object.keys(CATALOG).sort()) {
        const entry = CATALOG[name];
        if (!entry) continue;
        const scoped = entry.scopeField ? "scoped" : "unscoped";
        process.stdout.write(`${name} -> ${entry.authId} (${scoped})\n`);
      }
    });

  cmd
    .command("raw <path>")
    .description("GET an arbitrary API path, e.g. `ct get raw /groups/42` (list endpoints are paginated)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .option(
      "--no-paginate",
      "issue exactly one request instead of following pagination (warns if rows were left behind)",
    )
    .option("--page <n>", "fetch exactly this page (implies --no-paginate)")
    .action(async (path: string, opts: RawOptions) => {
      await prepareEnvHost(opts); // #22: wire the env's host/token before authenticating
      const { client } = await authedSession();
      const target = path.startsWith("/") ? path : `/${path}`;
      await getRaw(client, target, opts);
    });

  return cmd;
}

interface RawOptions {
  env?: string;
  /** Commander's negatable `--no-paginate`: true unless the flag was passed. */
  paginate?: boolean;
  page?: string;
}

/**
 * `ct get raw <path>` (#100). Before this, raw issued ONE plain request and printed whatever came
 * back — which for any CT list endpoint is its default first page (10 rows) with no hint that the
 * rest exist. That made raw disagree with the typed commands by hundreds of rows on the same path,
 * and the output (a valid-looking JSON array) gave the reader no reason to doubt it.
 *
 * So raw now follows pagination like the typed commands, while staying an honest escape hatch:
 *
 *  - a probe request runs FIRST, with no paging params added. A non-array body (`/groups/42`,
 *    `/whoami`) is printed as-is — paging params are never appended to an endpoint that isn't a
 *    list, so no path can start 400ing because raw got clever.
 *  - an array body whose `meta.pagination` says more rows exist is re-read through `getAll`.
 *  - `--no-paginate` / `--page <n>` / a caller-supplied `page=`/`limit=` in the path keep the
 *    single-request behaviour for deliberate probing — and then a dropped-rows WARNING is loud,
 *    because silence is the one thing this must never do again.
 */
export async function getRaw(
  client: Pick<CtClient, "getRaw" | "getAll">,
  target: string,
  opts: RawOptions,
): Promise<void> {
  let page: number | undefined;
  if (opts.page !== undefined) {
    if (!/^\d+$/.test(String(opts.page).trim()) || Number.parseInt(String(opts.page), 10) < 1) {
      throw new Error(`Invalid --page "${opts.page}" — expected a positive integer.`);
    }
    page = Number.parseInt(String(opts.page), 10);
  }
  // A path that already carries page/limit is the caller hand-rolling their own paging: honour it
  // verbatim rather than appending a second, conflicting pair.
  const single = opts.paginate === false || page !== undefined || hasOwnPageParams(target);

  if (single) {
    const path = page !== undefined ? withPageParams(target, page, DEFAULT_RAW_PAGE_LIMIT) : target;
    const { data, meta } = await client.getRaw(path);
    out(data);
    reportRows(data, meta);
    return;
  }

  const probe = await client.getRaw(target);
  if (!Array.isArray(probe.data) || !hasMorePages(probe.meta, probe.data.length)) {
    out(probe.data);
    reportRows(probe.data, probe.meta);
    return;
  }
  const all = await client.getAll(target);
  out(all.data);
  reportRows(all.data, all.meta);
}

/** Page size for `--page <n>`, matching the client's own default so page N means the same thing. */
const DEFAULT_RAW_PAGE_LIMIT = 100;

/** Echo the row count on stderr, and WARN whenever rows were left behind (never silent — #100). */
function reportRows(data: unknown, meta: CtMeta | undefined): void {
  if (!Array.isArray(data)) {
    return; // single object — pagination does not apply
  }
  const total = meta?.pagination?.total;
  if (hasMorePages(meta, data.length)) {
    warn(
      `INCOMPLETE: returned ${data.length} of ${total ?? "more"} row(s) — this endpoint is paginated ` +
        `and only part of it was fetched. Drop --page/--no-paginate (or the page=/limit= in the path) ` +
        `to fetch every page.`,
    );
    return;
  }
  info(total !== undefined && total !== data.length ? `${data.length} of ${total} total` : `${data.length} total`);
}
