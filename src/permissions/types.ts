/**
 * Desired-state shape for permission declarations (`ct.groupRole` /
 * `ct.groupTypeRole` in the config DSL). These reconcile through their own
 * subsystem (see `src/permissions/grants.ts`), not the group engine, so they
 * are collected as a separate list from `DesiredResource[]`.
 */
import type { DomainType } from "./grants.js";
import type { Ref } from "../resolve/refs.js";

/**
 * A scope entry is either a logical key of a group managed by this tool, or a raw numeric dataId
 * (#49 escape hatch) — required for scoped rights whose scope dimension (catalog `scopeField`) is
 * not a group, since there is no logical/managed representation to reference by key there.
 */
export type Grant = string | { right: string; scope: (string | number)[] };

export interface DesiredPermission {
  key: string;
  domainType: DomainType;
  /**
   * The permission domain. A raw number (escape hatch), or a logical {@link Ref} (#20) the per-host
   * resolver turns into a numeric id at plan time (see `buildPermissionPlan`). Only ever a number
   * downstream of resolution.
   */
  domainId: number | Ref;
  grants: Grant[];
}
