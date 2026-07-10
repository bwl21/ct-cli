/**
 * Reverse reference resolution for `ct adopt` (#52 item A): turn the numeric ChurchTools ids a
 * fetched resource carries (`campusId`, `groupTypeId`) into the logical sugar the DSL already
 * accepts (`campus`/`groupType`), so an adopted snippet is portable and reads like something a
 * human would author — not a wall of instance-specific integers. `groupStatusId` is NOT reverse-
 * sugared (#67): group statuses have no REST catalog to look a name up against (`/group/memberstatus`
 * is a different dimension — member statuses, string ids — live-verified 2026-07-10), so adopt
 * always emits it as a plain numeric field, same as any other unmapped id.
 *
 * This is the mirror image of the forward {@link Resolver} (src/resolve/resolver.ts): it reads the
 * SAME master-data catalogs, matched here BY ID instead of by name, and emits `slug(name)` — exactly
 * the key the forward resolver's slug-primary match will map back to the same id on any host. Each
 * catalog is fetched at most once and cached; a fetch that fails (endpoint unreachable, non-array
 * body) degrades to "no catalog", so adopt never fails just because a lookup could not be resolved —
 * the caller keeps the numeric id and flags it with a `// TODO: no logical match` comment.
 */
import type { CtClient } from "../api/ctClient.js";
import { slug } from "../resources/registry.js";

/**
 * The numeric id fields adopt can reverse-sugar, each mapped to its catalog path and the logical DSL
 * field it sugars into. Mirrors context.ts `ID_SUGAR` (sugar → idField) and resolver.ts `CATALOG_PATH`
 * (kind → path); kept explicit (two entries) rather than derived, with this comment as the sync note.
 * `groupStatusId` is deliberately absent — see the file-level comment above (#67).
 */
const REVERSE_ID_FIELDS: Record<string, { catalog: string; sugar: string }> = {
  campusId: { catalog: "/campuses", sugar: "campus" },
  groupTypeId: { catalog: "/group/grouptypes", sugar: "groupType" },
};

interface CatalogRecord {
  id: number;
  name?: string;
  [k: string]: unknown;
}

export class ReverseResolver {
  private readonly client: Pick<CtClient, "get">;
  /** id → logical key, per catalog path, fetched at most once. A failed fetch caches an empty map. */
  private readonly catalogs = new Map<string, Promise<Map<number, string>>>();

  constructor(client: Pick<CtClient, "get">) {
    this.client = client;
  }

  private index(path: string): Promise<Map<number, string>> {
    let p = this.catalogs.get(path);
    if (!p) {
      p = this.client
        .get<CatalogRecord[]>(path)
        .then((rows) => {
          const map = new Map<number, string>();
          if (Array.isArray(rows)) {
            for (const row of rows) {
              if (typeof row?.id === "number" && typeof row.name === "string" && row.name.length > 0) {
                map.set(row.id, slug(row.name));
              }
            }
          }
          return map;
        })
        // Adopt must not fail because a catalog is unreachable — degrade to "no matches" (→ TODO).
        .catch(() => new Map<number, string>());
      this.catalogs.set(path, p);
    }
    return p;
  }

  /** The logical key for a numeric id in the given catalog, or `undefined` when unmatched. */
  private async keyForId(catalog: string, id: number): Promise<string | undefined> {
    return (await this.index(catalog)).get(id);
  }

  /**
   * Reverse-sugar a managed-field bag for emission (#52 item A): each numeric id field with a catalog
   * match becomes its logical `campus`/`groupType` key (dropping the numeric field); an id with NO
   * match stays numeric and is named in `todos` so the emitter can flag it. Every other field —
   * including `groupStatusId`, which has no `REVERSE_ID_FIELDS` entry (#67) — passes through
   * untouched in its original position (and a `null` id — "no campus" — is omitted by the emitter).
   */
  async sugarFields(
    fields: Record<string, unknown>,
  ): Promise<{ fields: Record<string, unknown>; todos: Set<string> }> {
    const out: Record<string, unknown> = {};
    const todos = new Set<string>();
    for (const [field, value] of Object.entries(fields)) {
      const rule = REVERSE_ID_FIELDS[field];
      if (rule && typeof value === "number") {
        const key = await this.keyForId(rule.catalog, value);
        if (key !== undefined) {
          out[rule.sugar] = key;
        } else {
          out[field] = value;
          todos.add(field);
        }
        continue;
      }
      out[field] = value;
    }
    return { fields: out, todos };
  }
}
