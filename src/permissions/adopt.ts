/**
 * Grant adoption: read a live domain's permission rows and emit a paste-ready
 * `ct.groupRole({...})` / `ct.groupTypeRole({...})` config block, so an existing
 * instance's rights structure comes under management without hand-transcription
 * (issue #25).
 *
 * The live rows are run through the SAME normalization the planner uses
 * (`normalizeActual`) so what is emitted is exactly what a subsequent `ct plan`
 * would consider managed: the system baseline (`modifiedPid === -1`) and
 * inherited rows are dropped, and pre-existing revoke/deny rows are surfaced as
 * a note rather than emitted (the reconciler preserves them; re-authoring them
 * is out of scope here).
 *
 * Grants are NOT state-tracked resources, so adoption prints config only — it
 * never writes the state file. The caller makes that explicit in its output.
 */
import type { State } from "../state/state.js";
import { findByTypeId } from "../state/state.js";
import { CATALOG } from "./catalog.js";
import { normalizeActual, type DomainType, type GrantTuple, type RawPermission } from "./grants.js";

/** DSL function name for each domain type — the call the emitted block should be pasted as. */
const DSL_FN: Record<DomainType, string> = {
  group_role: "ct.groupRole",
  group_type_role: "ct.groupTypeRole",
};

interface ReverseEntry {
  name: string;
  scoped: boolean;
}

/**
 * authId → `module:right` reverse map, built once from the static catalog. The catalog is keyed by
 * name; adoption needs the inverse. If two names share an authId (shouldn't happen), the first wins
 * — deterministic because `Object.entries` preserves insertion order.
 */
function reverseCatalog(): Map<number, ReverseEntry> {
  const rev = new Map<number, ReverseEntry>();
  for (const [name, entry] of Object.entries(CATALOG)) {
    if (!rev.has(entry.authId)) {
      rev.set(entry.authId, { name, scoped: entry.scopeField != null });
    }
  }
  return rev;
}

/** A grant collapsed from the per-dataId rows CT returns: one entry per distinct authId. */
interface CollapsedGrant {
  authId: number;
  /** Distinct scope dataIds (group ids). Empty ⇒ an unscoped grant. */
  dataIds: number[];
  /** True when at least one row for this authId carried no dataId (an unscoped grant). */
  hasUnscoped: boolean;
}

/**
 * Collapse normalized grant tuples (one per dataId — CT reads scoped grants back one row per
 * dataId) into one {@link CollapsedGrant} per authId, preserving first-seen order and deduping
 * dataIds.
 */
function collapse(tuples: GrantTuple[]): CollapsedGrant[] {
  const byAuth = new Map<number, CollapsedGrant>();
  for (const t of tuples) {
    let g = byAuth.get(t.authId);
    if (!g) {
      g = { authId: t.authId, dataIds: [], hasUnscoped: false };
      byAuth.set(t.authId, g);
    }
    if (t.dataId.length === 0) {
      g.hasUnscoped = true;
    } else {
      for (const id of t.dataId) if (!g.dataIds.includes(id)) g.dataIds.push(id);
    }
  }
  return [...byAuth.values()];
}

/**
 * Build the paste-ready config block for a domain's adopted grants. Pure: takes the raw rows and
 * the state, returns the block text (comments and all). The command wrapper handles the fetch and
 * prints the result — this stays fully unit-testable without a network.
 */
export function emitAdoptedGrants(args: {
  domainType: DomainType;
  domainId: number;
  rows: RawPermission[];
  state: State;
}): string {
  const { domainType, domainId, rows, state } = args;
  const normalized = normalizeActual(rows);
  const grants = normalized.filter((t) => t.type === "grant");
  const revokes = normalized.filter((t) => t.type !== "grant");
  const rev = reverseCatalog();

  const lines: string[] = [];
  lines.push(`${DSL_FN[domainType]}({`);
  lines.push(`  key: "${domainType}_${domainId}", // a logical key, unique across the config — rename to taste`);
  lines.push(`  id: ${domainId},`);

  if (grants.length === 0) {
    lines.push("  grants: [], // no user-authored grants on this domain (baseline/inherited rows excluded)");
  } else {
    lines.push("  grants: [");
    for (const g of collapse(grants)) {
      lines.push(...grantLines(g, rev, state));
    }
    lines.push("  ],");
  }

  lines.push("});");

  if (revokes.length > 0) {
    lines.push(
      `// NOTE: ${revokes.length} revoke/deny row(s) exist on this domain. The reconciler PRESERVES them (it never`,
    );
    lines.push(
      "// deletes a deny it did not author), so they are intentionally not emitted above. Re-authoring denies as",
    );
    lines.push("// config is not supported yet (see issue #25 stretch goal).");
  }

  return lines.join("\n");
}

/** Emit the grant line(s) for one collapsed grant, resolving scope dataIds back to state keys. */
function grantLines(g: CollapsedGrant, rev: Map<number, ReverseEntry>, state: State): string[] {
  const entry = rev.get(g.authId);
  if (!entry) {
    // Unknown authId → no name to emit. A numeric grant is not valid DSL, so surface it as a
    // clearly-marked comment rather than emitting invalid config or failing the whole adoption.
    return [
      `    // WARNING: authId ${g.authId} has no catalog entry — cannot map to a "module:right" name.`,
      "    //          Regenerate the catalog (see docs) or add this right by hand.",
    ];
  }

  // Unscoped grant → a bare "module:right" string.
  if (g.dataIds.length === 0) {
    return [`    ${JSON.stringify(entry.name)},`];
  }

  // Scoped grant → resolve each dataId (a group id) back to a MANAGED group's logical key. Scope
  // keys must be state keys (see src/permissions/scope.ts), so an unmanaged dataId cannot be
  // emitted as a key — it becomes a placeholder comment telling the user to adopt/declare it first.
  const resolvedKeys: string[] = [];
  const unmanaged: number[] = [];
  for (const id of g.dataIds) {
    const group = findByTypeId(state, "group", id);
    if (group) resolvedKeys.push(group.key);
    else unmanaged.push(id);
  }

  const out: string[] = [];
  for (const id of unmanaged) {
    out.push(
      `    // WARNING: scope target group #${id} is not managed — run \`ct adopt group ${id}\` (or declare it),`,
    );
    out.push(`    //          then add its logical key to the scope array below.`);
  }
  if (resolvedKeys.length > 0) {
    const scope = resolvedKeys.map((k) => JSON.stringify(k)).join(", ");
    out.push(`    { right: ${JSON.stringify(entry.name)}, scope: [${scope}] },`);
  } else {
    // Every scope target is unmanaged: there is no valid key to emit, so the grant itself is a
    // commented placeholder the user completes after adopting the group(s) above.
    out.push(`    // { right: ${JSON.stringify(entry.name)}, scope: [/* adopt the group(s) above first */] },`);
  }
  return out;
}
