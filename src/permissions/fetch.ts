/**
 * The one read every permission path shares: `GET /permissions/<domainType>` (and its
 * `/<domainId>` form).
 *
 * These reads were written as a plain `client.get`, on the belief that a permission domain returns a
 * single instance-wide blob rather than a paged list. That belief is not checked anywhere, and #100
 * is the whole catalogue of what happens when it is wrong: a paged endpoint read with a plain `get`
 * returns CT's default first page as a valid-looking array, with `meta` — the only evidence rows are
 * missing — discarded by `request()`'s `data` unwrap. On a host with a few hundred authored grants
 * that would make `ct plan` see a truncated actual set (re-PUTting grants that already exist),
 * `ct coverage` under-report, and `ct adopt grants --all-declarable` skip most role instances as
 * "no authored grants" — all of it silent, all of it looking exactly like a correct run.
 *
 * So the assumption is now enforced instead of assumed: read the envelope, and if `meta.pagination`
 * says more rows exist than arrived, page the endpoint properly rather than returning a first page.
 * When the endpoint is un-paged (the expected case today) this costs one request, exactly as before.
 */
import { hasMorePages, type CtClient } from "../api/ctClient.js";
import type { RawPermission } from "./grants.js";

/**
 * A client able to perform the guarded read. `getRaw`/`getAll` are optional so the callers' existing
 * `Pick<CtClient, "get">` contract still holds for the narrow test doubles that supply only `get` —
 * a real {@link CtClient} always carries all three and always takes the guarded path.
 */
export type PermissionReader = Pick<CtClient, "get"> & Partial<Pick<CtClient, "getRaw" | "getAll">>;

/** Read one permission domain's rows, following pagination if the endpoint turns out to paginate. */
export async function fetchPermissionRows(client: PermissionReader, path: string): Promise<RawPermission[]> {
  if (!client.getRaw || !client.getAll) {
    // No envelope access (test double): fall back to the plain read rather than silently returning
    // nothing. Production always has both.
    const rows = await client.get<RawPermission[]>(path);
    return Array.isArray(rows) ? rows : [];
  }
  const { data, meta } = await client.getRaw<RawPermission[]>(path);
  const rows = Array.isArray(data) ? data : [];
  if (!hasMorePages(meta, rows.length)) {
    return rows;
  }
  const all = await client.getAll<RawPermission>(path);
  return all.data;
}
