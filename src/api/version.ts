/**
 * ChurchTools exposes its release via `GET /info` (`version`, e.g. "3.123.0").
 * Group-hierarchy and group-metadata CRUD require v3.96+, so the CLI asserts a
 * minimum before it will plan/apply. See docs/api-coverage.md (Phase 0).
 */
export const MIN_CT_VERSION = "3.96.0";

export interface CtInfo {
  version?: string;
  build?: string;
}

/** Compare dotted numeric versions. Returns <0, 0, >0 like a comparator. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function meetsMinVersion(version: string, min: string = MIN_CT_VERSION): boolean {
  return compareVersions(version, min) >= 0;
}
