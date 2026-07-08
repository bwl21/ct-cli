/**
 * Human-readable, Terraform-style rendering of a permission plan.
 * Mirrors `src/engine/render.ts`'s picocolors conventions.
 */
import pc from "picocolors";
import type { PermissionPlanItem } from "./plan.js";
import type { GrantTuple } from "./grants.js";

function fmtTuple(t: GrantTuple): string {
  const scope = t.dataId.length ? ` scope=[${t.dataId.join(",")}]` : "";
  return `authId=${t.authId}${scope} (${t.type})`;
}

export function renderPermissionPlan(items: PermissionPlanItem[]): string {
  const changed = items.filter((i) => i.diff.toPut.length > 0 || i.diff.toDelete.length > 0);

  if (changed.length === 0) {
    return pc.green("No permission changes. Desired grants match ChurchTools.");
  }

  const lines: string[] = [];
  let totalGrant = 0;
  let totalRevoke = 0;

  for (const item of changed) {
    const grantCount = item.diff.toPut.length;
    const revokeCount = item.diff.toDelete.length;
    totalGrant += grantCount;
    totalRevoke += revokeCount;
    lines.push(
      `  ${item.domainType} #${item.domainId} (${item.key}): ${pc.green(`+${grantCount} grant(s)`)}, ${pc.red(`-${revokeCount} remove(s)`)}`,
    );
    for (const t of item.diff.toPut) {
      lines.push(`      ${pc.green("+")} ${fmtTuple(t)}`);
    }
    for (const t of item.diff.toDelete) {
      lines.push(`      ${pc.red("-")} ${fmtTuple(t)}`);
    }
  }

  lines.push("");
  lines.push(pc.bold(`Permission plan: ${totalGrant} to grant, ${totalRevoke} to remove.`));
  return lines.join("\n");
}
