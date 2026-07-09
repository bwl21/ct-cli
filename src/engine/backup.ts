/**
 * Automatic pre-write backup. Before any apply/destroy touches ChurchTools, the
 * current *actual* values of the managed resources are dumped to a timestamped
 * JSON file, so the affected area can be inspected/restored.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isSyntheticField } from "./synthetic.js";

/**
 * Drop synthetic pseudo-fields (`parents`, `dynamic`, …) from an actual record.
 *
 * `buildPlan` folds these into its `actual` map IN PLACE for diffing, and apply
 * reuses that same map for the backup. They are internal logical-key sets, not
 * real CT columns, so they are non-restorable noise in a backup — strip them so
 * the file holds only real, restorable values (and matches destroy's clean backup).
 */
function realFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!isSyntheticField(k)) out[k] = v;
  }
  return out;
}

export async function writeBackup(
  dir: string,
  host: string,
  actual: Map<string, Record<string, unknown>>,
  now: Date = new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/:/g, "-");
  const path = join(dir, `ct-backup-${stamp}.json`);
  const payload = {
    host,
    capturedAt: now.toISOString(),
    resources: Object.fromEntries([...actual].map(([key, fields]) => [key, realFields(fields)])),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}
