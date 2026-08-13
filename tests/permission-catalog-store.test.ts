/**
 * Per-instance permission catalog (#105).
 *
 * The bundled catalog is a snapshot of ONE ChurchTools version, and the staleness warning it produced
 * told consumer repos to run a script that only exists in the ct-cli repo — unactionable where it was
 * printed, and printed on every single plan, which is how a warning stops being read.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capturePermissionCatalog,
  hostCatalogPath,
  loadHostCatalog,
  writeHostCatalog,
} from "../src/permissions/catalog-store.js";
import {
  CATALOG,
  CATALOG_IS_PER_INSTANCE,
  CATALOG_META,
  KNOWN_AUTH_IDS,
  KNOWN_SCOPE_FIELDS,
  SCOPE_FIELD_BY_AUTH_ID,
  resolveAuthId,
  useBundledCatalog,
} from "../src/permissions/catalog.js";

const HOST = "https://mychurch.church.tools";
let workDir: string | undefined;

afterEach(() => {
  useBundledCatalog(); // the catalog is process-global — never leak a capture into another test
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = undefined;
});

function tempCatalogDir(contents?: unknown): string {
  workDir = mkdtempSync(join(tmpdir(), "ct-catalog-"));
  if (contents !== undefined) {
    writeFileSync(hostCatalogPath(HOST, workDir), JSON.stringify(contents), "utf8");
  }
  return workDir;
}

describe("hostCatalogPath", () => {
  it("keeps one file per instance so dev and prod captures coexist", () => {
    expect(hostCatalogPath("https://dev.church.tools", ".ct")).toBe(
      ".ct/permission-catalog.dev.church.tools.json",
    );
    expect(hostCatalogPath("https://prod.church.tools/", ".ct")).toBe(
      ".ct/permission-catalog.prod.church.tools.json",
    );
  });
});

describe("loadHostCatalog", () => {
  it("returns null and leaves the bundled catalog active when no capture exists", async () => {
    const dir = tempCatalogDir();
    expect(await loadHostCatalog(HOST, dir)).toBeNull();
    expect(CATALOG_IS_PER_INSTANCE).toBe(false);
    expect(CATALOG["churchcore:administer settings"]).toBeDefined();
  });

  it("replaces every derived index, not just the name map", async () => {
    const dir = tempCatalogDir({
      $meta: {
        capturedFrom: "mychurch.church.tools",
        ctVersion: "9.9.9",
        capturedAt: "2026-08-13",
        rightCount: 1,
      },
      "newmodule:new right": { authId: 4242, scopeField: "cdb_zone", revocable: false, desc: "New" },
    });

    const path = await loadHostCatalog(HOST, dir);

    expect(path).toBe(hostCatalogPath(HOST, dir));
    expect(resolveAuthId("newmodule:new right").authId).toBe(4242);
    // A stale index here would be worse than no swap at all: `KNOWN_AUTH_IDS` decides which live
    // grants are safe to reconcile, and `SCOPE_FIELD_BY_AUTH_ID` decides what `preserveUnknown` keeps.
    expect(KNOWN_AUTH_IDS.has(4242)).toBe(true);
    expect(KNOWN_AUTH_IDS.has(1)).toBe(false); // the bundled rights are gone, not merged
    expect(SCOPE_FIELD_BY_AUTH_ID.get(4242)).toBe("cdb_zone");
    expect(KNOWN_SCOPE_FIELDS.has("cdb_zone")).toBe(true);
    expect(CATALOG_META?.ctVersion).toBe("9.9.9");
    expect(CATALOG_IS_PER_INSTANCE).toBe(true);
  });

  it("throws on a malformed capture instead of silently planning against a different catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ct-catalog-"));
    workDir = dir;
    writeFileSync(hostCatalogPath(HOST, dir), "{ not json", "utf8");
    await expect(loadHostCatalog(HOST, dir)).rejects.toThrow(/not valid JSON/);
    expect(CATALOG_IS_PER_INSTANCE).toBe(false);
  });

  it("rejects a top-level array", async () => {
    const dir = tempCatalogDir([]);
    await expect(loadHostCatalog(HOST, dir)).rejects.toThrow(/expected a JSON object/);
  });

  // "It parsed as an object" is not enough for a file that decides what a permission NAME means: an
  // entry with no authId resolves truthily, matches no actual, and reaches `ct apply` as a PUT
  // carrying `authId: undefined`. It has to fail here, not three layers downstream on a write.
  it("rejects an entry with no numeric authId rather than PUTting `authId: undefined` later", async () => {
    const dir = tempCatalogDir({ "churchdb:view": { scopeField: null, revocable: false, desc: "" } });
    await expect(loadHostCatalog(HOST, dir)).rejects.toThrow(/right "churchdb:view" has no numeric authId/);
    expect(CATALOG_IS_PER_INSTANCE).toBe(false);
  });

  it("rejects an entry whose scopeField is neither a string nor null", async () => {
    const dir = tempCatalogDir({ "churchdb:view": { authId: 1, scopeField: 7, revocable: false, desc: "" } });
    await expect(loadHostCatalog(HOST, dir)).rejects.toThrow(/scopeField that is neither a string nor null/);
  });
});

describe("capturePermissionCatalog", () => {
  // Typed through the capture function's own parameter so the fake stays honest about its shape.
  const client: Parameters<typeof capturePermissionCatalog>[0] = {
    host: HOST,
    version: "3.135.2",
    legacyPostForm: (async () => ({
      data: {
        auth_table: {
          churchdb: {
            "view station": {
              id: 124,
              datenfeld: "cdb_station",
              bezeichnung: "Standort sehen",
              isRevocable: 1,
            },
            "view alldata": { id: 102, datenfeld: "", bezeichnung: "Alle sehen", isRevocable: false },
          },
        },
      },
    })) as (typeof client)["legacyPostForm"],
  };

  it("flattens auth_table into the catalog schema and stamps its provenance", async () => {
    const catalog = await capturePermissionCatalog(client);
    expect(catalog["churchdb:view station"]).toEqual({
      authId: 124,
      scopeField: "cdb_station",
      revocable: true,
      desc: "Standort sehen",
    });
    // An empty `datenfeld` means UNSCOPED — not a dimension named "".
    expect(catalog["churchdb:view alldata"]).toMatchObject({ scopeField: null, revocable: false });
    expect(catalog.$meta).toMatchObject({
      capturedFrom: "mychurch.church.tools",
      ctVersion: "3.135.2",
      rightCount: 2,
    });
  });

  it("fails loudly if the legacy endpoint's shape changed, rather than writing an empty catalog", async () => {
    await expect(
      capturePermissionCatalog({
        ...client,
        legacyPostForm: (async () => ({ data: {} })) as (typeof client)["legacyPostForm"],
      }),
    ).rejects.toThrow(/no data\.auth_table/);
  });

  it("round-trips through writeHostCatalog into a loadable per-instance catalog", async () => {
    const dir = tempCatalogDir();
    const path = await writeHostCatalog(HOST, await capturePermissionCatalog(client), dir);
    expect(JSON.parse(readFileSync(path, "utf8"))["churchdb:view station"].authId).toBe(124);
    await loadHostCatalog(HOST, dir);
    expect(resolveAuthId("churchdb:view station").authId).toBe(124);
  });
});
