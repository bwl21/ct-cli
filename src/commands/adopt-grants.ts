import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { assertNotPeople } from "../engine/guard.js";
import { emitAdoptedGrants } from "../permissions/adopt.js";
import type { DomainType, RawPermission } from "../permissions/grants.js";
import { loadState, resolveStatePath } from "../state/state.js";
import { info, warn } from "../ui.js";

interface AdoptGrantsOptions {
  state?: string;
}

/** Accept the DSL's `group_role` and the hyphenated CLI-friendly `group-role`; reject anything else. */
function normalizeDomainType(raw: string): DomainType {
  const t = raw.trim().replace(/-/g, "_");
  if (t === "group_role" || t === "group_type_role") return t;
  throw new Error(
    `Invalid domain type "${raw}" — expected "group_role" or "group_type_role" (people domains are never managed).`,
  );
}

/**
 * `ct adopt grants <domainType> <domainId>` — read the live permission rows for a domain and print
 * a paste-ready `ct.groupRole` / `ct.groupTypeRole` config block. Grants are NOT state-tracked, so
 * this prints config only; it never writes the state file (contrast `ct adopt <type> <id>`).
 */
export function adoptGrantsCommand(): Command {
  return new Command("grants")
    .description("Print a paste-ready grants config block from a live domain's permission rows (does not write state)")
    .argument("<domainType>", "group_role | group_type_role")
    .argument("<domainId>", "the domainId of the permission domain object")
    .option("-s, --state <path>", "state file path (or set CT_STATE) — used to resolve scope group ids to keys")
    .action(async (rawType: string, rawId: string, opts: AdoptGrantsOptions) => {
      const domainType = normalizeDomainType(rawType);
      if (!/^\d+$/.test(rawId.trim())) {
        throw new Error(`Invalid domainId "${rawId}" — expected a non-negative integer.`);
      }
      const domainId = Number.parseInt(rawId, 10);
      const path = `/permissions/${domainType}/${domainId}`;
      assertNotPeople(path); // belt-and-suspenders: the domain-type guard already excludes people

      // Load + validate the state file (host guard) BEFORE any network call, mirroring `ct adopt`,
      // so a state file recorded against another instance never triggers a request to the wrong host.
      const config = await resolveConfig();
      const statePath = resolveStatePath(opts.state);
      const state = await loadState(statePath, config.host);

      const { client } = await authedSession();
      const rows = await client.get<RawPermission[]>(path);

      const block = emitAdoptedGrants({ domainType, domainId, rows, state });

      info(`Grants are not state-tracked — this prints config only and does NOT write ${statePath}.`);
      info(`Paste the block below into your config, then run \`ct plan\` (it should be a no-op if unchanged):`);
      process.stdout.write(`${block}\n`);
      warn("Review any WARNING/NOTE comments in the block before committing.");
    });
}
