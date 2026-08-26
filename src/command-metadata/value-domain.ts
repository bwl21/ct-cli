import type { Argument, Option } from "commander";

export interface ParameterValueDomain {
  /** Why this metadata exists; projections must not interpret it as command execution policy. */
  purpose: "parameter-value-domain";
  /** Live catalogs may be unavailable or permission-filtered, so manual input remains valid. */
  constraint: "suggestions";
  source: {
    kind: "ct-command";
    command: string[];
    valueField: string;
    labelFields: string[];
  };
}

const DOMAINS = new WeakMap<object, ParameterValueDomain>();

/** Attach a value-domain description directly to the Commander parameter it describes. */
export function withValueDomain<T extends Argument | Option>(parameter: T, domain: ParameterValueDomain): T {
  DOMAINS.set(parameter, domain);
  return parameter;
}

export function valueDomainOf(parameter: Argument | Option): ParameterValueDomain | undefined {
  return DOMAINS.get(parameter);
}

export const GROUP_VALUE_DOMAIN: ParameterValueDomain = {
  purpose: "parameter-value-domain",
  constraint: "suggestions",
  source: {
    kind: "ct-command",
    command: ["get", "groups"],
    valueField: "id",
    labelFields: ["name", "id"],
  },
};

export const GROUP_TYPE_VALUE_DOMAIN: ParameterValueDomain = {
  purpose: "parameter-value-domain",
  constraint: "suggestions",
  source: {
    kind: "ct-command",
    command: ["get", "group-types"],
    valueField: "id",
    labelFields: ["name", "id"],
  },
};
