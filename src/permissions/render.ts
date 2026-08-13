/**
 * Human-readable, Terraform-style rendering of a permission plan.
 * Mirrors `src/engine/render.ts`'s picocolors conventions.
 */
import pc from "picocolors";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";
import { refLabel } from "../resolve/refs.js";

/**
 * The domain identifier for a plan line: a concrete `#id`, or — when the domain is a group type
 * created in this same run (#69) — a `<group-type:x (created this apply)>` marker consistent with the
 * resource pending-ref rendering (src/engine/render.ts). Its real id is filled in at apply time.
 */
function fmtDomain(item: PermissionPlanItem): string {
  return item.pendingDomain
    ? `<${refLabel(item.pendingDomain)} (created this apply)>`
    : `#${item.domainId}`;
}

function fmtTuple(t: GrantTuple): string {
  let scope = "";
  if (t.pending && t.scopeKey != null) {
    scope = ` scope=[${t.scopeKey} (created this apply)]`;
  } else if (t.dataId.length) {
    scope = ` scope=[${t.dataId.join(",")}]`;
  }
  return `authId=${t.authId}${scope} (${t.type})`;
}

export function renderPermissionPlan(items: PermissionPlanItem[]): string {
  // A `preserveUnknown` item can have an EMPTY diff and still deserve a line (#102): the whole point
  // of the opt-in is that "I deliberately left the module grants alone" is visible, and it would not
  // be if a role whose only interesting property is 41 preserved grants rendered as nothing at all.
  const changed = items.filter(
    (i) => i.diff.toPut.length > 0 || i.diff.toDelete.length > 0 || i.diff.preservedUnknown.length > 0,
  );

  if (changed.length === 0) {
    const preserved = items.reduce((n, i) => n + i.diff.preserved.length, 0);
    const suffix = preserved > 0
      ? ` (${preserved} pre-existing deny row(s) left untouched.)`
      : "";
    return pc.green(`No permission changes. Desired grants match ChurchTools.${suffix}`);
  }

  const lines: string[] = [];
  let totalGrant = 0;
  let totalRevoke = 0;
  let totalPreserved = 0;

  for (const item of changed) {
    const grantCount = item.diff.toPut.length;
    const revokeCount = item.diff.toDelete.length;
    const preservedCount = item.diff.preservedUnknown.length;
    totalGrant += grantCount;
    totalRevoke += revokeCount;
    totalPreserved += preservedCount;
    const preservedNote = preservedCount > 0 ? `, ${pc.dim(`~${preservedCount} preserved`)}` : "";
    lines.push(
      `  ${item.domainType} ${fmtDomain(item)} (${item.key}): ${pc.green(`+${grantCount} grant(s)`)}, ${pc.red(`-${revokeCount} remove(s)`)}${preservedNote}`,
    );
    for (const t of item.diff.toPut) {
      lines.push(`      ${pc.green("+")} ${fmtTuple(t)}`);
    }
    for (const t of item.diff.toDelete) {
      lines.push(`      ${pc.red("-")} ${fmtTuple(t)}`);
    }
    for (const t of item.diff.preservedUnknown) {
      lines.push(`      ${pc.dim(`~ ${fmtTuple(t)} (preserved, not managed — preserveUnknown)`)}`);
    }
    for (const t of item.diff.preserved) {
      lines.push(`      ${pc.dim(`~ ${fmtTuple(t)} (pre-existing deny — left untouched)`)}`);
    }
  }

  lines.push("");
  // Preserved grants are counted separately and never folded into the change totals: they are
  // explicitly what apply will NOT do.
  const preservedSummary = totalPreserved > 0 ? `, ${totalPreserved} preserved (not managed)` : "";
  lines.push(pc.bold(`Permission plan: ${totalGrant} to grant, ${totalRevoke} to remove${preservedSummary}.`));
  return lines.join("\n");
}
