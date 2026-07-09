import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { CATALOG } from "../permissions/catalog.js";
import { out } from "../ui.js";

/**
 * Read-only imperative queries — immediately useful before any declarative
 * engine exists. Resource → API path map. Paths confirmed against the live
 * spec by the Phase 0 spike (#2, CT 3.123.0); see docs/api-coverage.md.
 */
const RESOURCE_PATHS: Record<string, string> = {
  whoami: "/whoami",
  info: "/info",
  campuses: "/campuses",
  groups: "/groups",
  "group-hierarchies": "/groups/hierarchies",
  "group-types": "/group/grouptypes",
  "group-roles": "/group/roles",
  "age-groups": "/group/agegroups",
  "target-groups": "/group/targetgroups",
  "dynamic-groups": "/dynamicgroups",
  "relationship-types": "/person/relationshiptypes",
  permissions: "/permissions/global",
};

export function getCommand(): Command {
  const cmd = new Command("get").description("Read structure resources from ChurchTools (JSON to stdout)");

  for (const [name, path] of Object.entries(RESOURCE_PATHS)) {
    cmd
      .command(name)
      .description(`GET ${path}`)
      .action(async () => {
        const { client } = await authedSession();
        out(await client.get(path));
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
    .description("GET an arbitrary API path, e.g. `ct get raw /groups/42`")
    .action(async (path: string) => {
      const { client } = await authedSession();
      out(await client.get(path.startsWith("/") ? path : `/${path}`));
    });

  return cmd;
}
