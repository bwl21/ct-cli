/**
 * The ONE place that reads `GET /dynamicgroups` (#113/#124).
 *
 * The endpoint does not return objects. It returns a flat array of the GROUP ids that have a
 * ruleset:
 *
 * ```json
 * [159, 1698, 1704, 1707, 1710, 1713, 1740, 1748, 1753]
 * ```
 *
 * Two call sites independently read those rows as `Number(row.id ?? row.groupId)`, which is
 * `Number(undefined)` → `NaN` for every element, so the id set came out EMPTY on every host. That
 * silently broke both consumers in the way that looks like good news rather than like a bug:
 * `ct coverage` reported `dynamic: 0` on an instance with 70 auto-groups, and `ct refresh` answered
 * "not a dynamic group" for every group, on every host, so the command could not succeed at all.
 *
 * Hence one parser, one test, and a shape that tolerates both spellings — an array of scalars is
 * easy to re-break, and CT could plausibly grow an object form later.
 */
import type { CtClient } from "./ctClient.js";

/**
 * Coerce one `/dynamicgroups` row to a group id.
 *
 * Accepts the scalar form the endpoint actually returns (`1753`, and the numeric-string variant CT
 * is prone to elsewhere) as well as an object carrying `id`/`groupId`. Returns `undefined` for
 * anything that does not yield a finite id, so callers can simply skip it.
 */
export function dynamicGroupRowId(row: unknown): number | undefined {
  const raw =
    typeof row === "object" && row !== null
      ? ((row as Record<string, unknown>).id ?? (row as Record<string, unknown>).groupId)
      : row;
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  const id = Number(raw);
  return Number.isFinite(id) ? id : undefined;
}

/** Parse a whole `/dynamicgroups` payload into the set of group ids that have a ruleset. */
export function parseDynamicGroupIds(rows: readonly unknown[]): Set<number> {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = dynamicGroupRowId(row);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

/** Fetch the set of group ids that are auto-groups on this host. One cheap, un-paged request. */
export async function fetchDynamicGroupIds(client: Pick<CtClient, "getAll">): Promise<Set<number>> {
  const { data } = await client.getAll<unknown>("/dynamicgroups");
  return parseDynamicGroupIds(data);
}
