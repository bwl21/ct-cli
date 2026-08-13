/**
 * `ct permissions catalog` (#105) — inspect, and REFRESH, the name↔authId permission catalog.
 *
 * The refresh is the point: the catalog ships as a snapshot of one ChurchTools version, and until now
 * the only way to update it was `npm run regenerate:permission-catalog` inside the ct-cli repo. A
 * consumer repo therefore could not act on the staleness warning its own plans printed. This command
 * captures the catalog from the repo's OWN instance into `.ct/permission-catalog.<host>.json`, which
 * every subsequent plan/apply against that host loads in preference to the bundled one.
 */
import { Command } from "commander";
import { authedSession } from "../api/session.js";
import { resolveConfig } from "../config.js";
import { prepareEnvHost } from "../env/context.js";
import { CATALOG, CATALOG_META } from "../permissions/catalog.js";
import {
  capturePermissionCatalog,
  hostCatalogPath,
  loadHostCatalog,
  writeHostCatalog,
} from "../permissions/catalog-store.js";
import { info, success, warn } from "../ui.js";

interface CatalogOptions {
  env?: string;
  refresh?: boolean;
}

export function permissionsCommand(): Command {
  const cmd = new Command("permissions").description("Inspect or refresh the permission catalog");

  cmd
    .command("catalog")
    .description(
      "Show the active permission catalog's provenance, or capture a fresh one for this instance " +
        "with --refresh (writes .ct/permission-catalog.<host>.json)",
    )
    .option("-e, --env <name>", "environment profile from ct.envs.json (targets that host)")
    .option("--refresh", "capture the catalog from the live instance and write it for this host")
    .action(async (opts: CatalogOptions) => {
      await prepareEnvHost(opts);
      const config = await resolveConfig();

      if (!opts.refresh) {
        // Offline: report which catalog WOULD be used for this host, and where it came from.
        const loaded = await loadHostCatalog(config.host);
        info(
          loaded
            ? `Active catalog: ${loaded} (per-instance capture)`
            : `Active catalog: bundled with this ct release (no ${hostCatalogPath(config.host)})`,
        );
        if (CATALOG_META) {
          info(
            `  captured from ${CATALOG_META.capturedFrom} · ChurchTools ${CATALOG_META.ctVersion} · ` +
              `${CATALOG_META.capturedAt} · ${Object.keys(CATALOG).length} rights`,
          );
        }
        if (!loaded) {
          info(`  refresh it for this instance: \`ct permissions catalog --refresh${opts.env ? ` --env ${opts.env}` : ""}\``);
        }
        return;
      }

      const { client } = await authedSession();
      const catalog = await capturePermissionCatalog(client);
      const path = await writeHostCatalog(config.host, catalog);
      const meta = catalog.$meta as { rightCount: number; ctVersion: string };
      success(`Wrote ${path} — ${meta.rightCount} rights · ChurchTools ${meta.ctVersion} · ${config.host}`);
      info("Commit this file: every plan/apply against this host will use it instead of the bundled catalog.");
      warn(
        "Review the diff before committing — an authId that MOVED changes what a declared right grants.",
      );
    });

  return cmd;
}
