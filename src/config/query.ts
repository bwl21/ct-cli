/**
 * Typed query builder for dynamic-group rulesets (Phase 2). Emits a JSONLogic
 * tree that lives inside the ChurchQuery `params.filter`. `var` values are raw
 * ChurchTools ids — resolve keys → ids at config-build time and pass the number.
 *
 * `churchQuery` wraps a filter in the same envelope shape ChurchTools itself
 * returns (see tests/fixtures/dynamic/ruleset-683.get.json, ruleset-2022.get.json,
 * ruleset-1092.get.json): `{ description, method: "ChurchQuery", params: {
 * groupBy, filter, primaryEntityAlias, responseFields } }`. Defaults are the
 * observed common case (grouping/returning by `person.id`); override via `opts`
 * for a query keyed on a different primary entity.
 */
export interface QueryNode {
  [op: string]: unknown;
}

export const q = {
  and: (...n: QueryNode[]): QueryNode => ({ and: n }),
  or: (...n: QueryNode[]): QueryNode => ({ or: n }),
  not: (n: QueryNode): QueryNode => ({ "!": n }),
  var: (name: string): QueryNode => ({ var: name }),
  eq: (varName: string, value: unknown): QueryNode => ({ "==": [{ var: varName }, value] }),
  oneof: (varName: string, values: unknown[]): QueryNode => ({ oneof: [{ var: varName }, values] }),
  isnull: (varName: string): QueryNode => ({ isnull: [{ var: varName }] }),
};

export interface ChurchQueryOptions {
  description?: string;
  groupBy?: string[];
  primaryEntityAlias?: string;
  responseFields?: string[];
}

/**
 * Wrap a JSONLogic filter in the ChurchQuery envelope the ruleset `query` field
 * expects. Defaults `method: "ChurchQuery"`, `params.groupBy: ["person.id"]`,
 * `params.primaryEntityAlias: "person"`, and `params.responseFields` to the
 * standard person id/name triple — the shape every observed production
 * ruleset uses. Pass `opts` to override any of these for a differently-keyed
 * query (e.g. one whose primary entity is `ctgroup`).
 */
export function churchQuery(filter: QueryNode, opts: ChurchQueryOptions = {}): Record<string, unknown> {
  const {
    description = "",
    groupBy = ["person.id"],
    primaryEntityAlias = "person",
    responseFields = ["person.id", "person.firstName", "person.lastName"],
  } = opts;
  return {
    description,
    method: "ChurchQuery",
    params: { groupBy, filter, primaryEntityAlias, responseFields },
  };
}
