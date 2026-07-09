/**
 * Desired-state shape for permission declarations (`ct.groupRole` /
 * `ct.groupTypeRole` in the config DSL). These reconcile through their own
 * subsystem (see `src/permissions/grants.ts`), not the group engine, so they
 * are collected as a separate list from `DesiredResource[]`.
 */
import type { DomainType } from "./grants.js";

export type Grant = string | { right: string; scope: string[] };

export interface DesiredPermission {
  key: string;
  domainType: DomainType;
  domainId: number;
  grants: Grant[];
}
