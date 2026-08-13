/**
 * `ct coverage` (#103) — the audit "what exists on this host that I am not managing, and could I
 * manage it?", built into the tool instead of hand-rolled per consumer repo.
 *
 * Reads only; writes nothing, touches no state. The joins it performs are the ones every repo was
 * doing by hand (`?include[]=roles` + `/dynamicgroups` + `/permissions/group_role`, minus inherited
 * rows); the verdict it computes — whether a role instance's grants are declarable — is the part only
 * `ct` can produce, because it needs the scope-dimension knowledge that lives in this codebase.
 */
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import type { CtClient } from "../api/ctClient.js";
import { resolveConfig } from "../config.js";
import { prepareEnv } from "../env/context.js";
import {
  buildCoverageReport,
  decodeGroupsWithRoles,
  renderCoverage,
  renderRoleInstances,
  type CoverageReport,
} from "../coverage/report.js";
import { fetchPermissionRows, type PermissionReader } from "../permissions/fetch.js";
import { loadHostCatalog } from "../permissions/catalog-store.js";
import { slug } from "../resources/registry.js";
import { loadState, type State } from "../state/state.js";
import { info, out } from "../ui.js";

interface CoverageOptions {
  state?: string;
  env?: string;
  json?: boolean;
  type?: string;
  declarable?: boolean;
  blocked?: boolean;
}

/**
 * `?include[]=roles` is the whole reason this command is cheap: without it, auditing role instances
 * means one `/groups/{id}/roles` call per group (645 of them on eqrm prod). With it, the same data
 * arrives in the paged group list.
 */
const GROUPS_WITH_ROLES = "/groups?include[]=roles";

export function coverageCommand(): Command {
  return new Command("coverage")
    .description("Report what ChurchTools has that the config does not manage, and what is declarable")
    .option("-s, --state <path>", "state file (or set CT_STATE)")
    .option("-e, --env <name>", "environment profile from ct.envs.json (host + state + token)")
    .option("--json", "emit the full report as JSON (for CI gates)")
    .option("--type <nameOrKey>", "restrict the role-instance detail to one group type")
    .option("--declarable", "list only role instances whose grants could be adopted today")
    .option("--blocked", "list only role instances blocked by an undeclarable scope dimension")
    .action(async (opts: CoverageOptions) => {
      const cmdEnv = await prepareEnv(opts);
      const config = await resolveConfig();
      const state = await loadState(cmdEnv.statePath, config.host);
      // The declarability verdict is computed from the catalog's authIds and scope dimensions, so it
      // must read the SAME catalog `ct plan` does for this host (#105) — otherwise a right the
      // committed capture can name is reported here as "blocked by authId N" (failing a `--json` CI
      // gate) while `ct plan` manages it without complaint.
      const hostCatalog = await loadHostCatalog(config.host);
      if (hostCatalog) info(`permission catalog: ${hostCatalog}`);
      const { client } = await authedSession();

      const report = await collectCoverage(client, config.host, state);

      let instances = report.roleInstances;
      if (opts.type) {
        const wanted = opts.type.trim();
        const typeIds = new Set(
          report.byType
            .filter((t) => t.name === wanted || slug(t.name) === slug(wanted))
            .map((t) => t.groupTypeId),
        );
        if (typeIds.size === 0) {
          throw new Error(
            `--type "${opts.type}": no group type matches (checked by name and slug against this host).`,
          );
        }
        instances = instances.filter((r) => typeIds.has(r.groupTypeId));
      }
      if (opts.declarable) instances = instances.filter((r) => r.verdict.declarable);
      if (opts.blocked) instances = instances.filter((r) => !r.verdict.declarable);

      if (opts.json) {
        out({ ...report, roleInstances: instances });
        return;
      }

      if (cmdEnv.name) info(`env: ${cmdEnv.name} · host: ${config.host} · state: ${cmdEnv.statePath}`);
      process.stdout.write(`${renderCoverage(report)}\n`);
      if (opts.type || opts.declarable || opts.blocked) {
        process.stdout.write(
          instances.length > 0 ? `\n${renderRoleInstances(instances)}\n` : "\nNo role instances match.\n",
        );
      }
    });
}

/** Fetch everything the report needs. Split out from the action so it is reusable and mockable. */
export async function collectCoverage(
  client: PermissionReader & Pick<CtClient, "getAll">,
  host: string,
  state: State,
): Promise<CoverageReport> {
  const [groupRows, groupTypeRows, dynamicRows, roleDefRows] = await Promise.all([
    client.getAll<Record<string, unknown>>(GROUPS_WITH_ROLES),
    client.getAll<Record<string, unknown>>("/group/grouptypes"),
    client.getAll<Record<string, unknown>>("/dynamicgroups"),
    client.getAll<Record<string, unknown>>("/group/roles"),
  ]);
  // Same guarded read the planner performs: one request while the endpoint stays un-paged, and a
  // proper paging pass if it ever does paginate — never a silent first page (see permissions/fetch.ts).
  const groupRolePermissions = await fetchPermissionRows(client, "/permissions/group_role");

  const groupTypeNames = new Map<number, string>();
  for (const row of groupTypeRows.data) {
    const id = Number(row.id);
    if (Number.isFinite(id) && typeof row.name === "string") groupTypeNames.set(id, row.name);
  }
  const roleNamesById = new Map<number, string>();
  for (const row of roleDefRows.data) {
    const id = Number(row.id);
    if (Number.isFinite(id) && typeof row.name === "string") roleNamesById.set(id, row.name);
  }
  const dynamicGroupIds = new Set<number>();
  for (const row of dynamicRows.data) {
    // `/dynamicgroups` rows are keyed by the GROUP id they belong to; tolerate either spelling.
    const id = Number(row.id ?? row.groupId);
    if (Number.isFinite(id)) dynamicGroupIds.add(id);
  }

  return buildCoverageReport({
    host,
    state,
    groups: decodeGroupsWithRoles(groupRows.data, roleNamesById),
    groupTypeNames,
    dynamicGroupIds,
    groupRolePermissions: Array.isArray(groupRolePermissions) ? groupRolePermissions : [],
  });
}
