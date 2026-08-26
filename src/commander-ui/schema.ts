import type { Argument, Command, Option } from "commander";
import { valueDomainOf, type ParameterValueDomain } from "../command-metadata/value-domain.js";

export type UiRisk = "read-only" | "state-write";
export type UiValueKind = "boolean" | "required" | "optional";

export interface UiArgumentSchema {
  name: string;
  description: string;
  required: boolean;
  variadic: boolean;
  choices?: string[];
  defaultValue?: unknown;
  valueDomain?: ParameterValueDomain;
}

export interface UiOptionSchema {
  key: string;
  short?: string;
  long: string;
  flags: string;
  description: string;
  valueKind: UiValueKind;
  mandatory: boolean;
  negated: boolean;
  choices?: string[];
  defaultValue?: unknown;
  valueDomain?: ParameterValueDomain;
}

export interface UiCommandSchema {
  path: string[];
  title: string;
  description: string;
  risk: UiRisk;
  arguments: UiArgumentSchema[];
  options: UiOptionSchema[];
}

const ALLOWED: ReadonlyMap<string, UiRisk> = new Map([
  ["adopt", "state-write"],
  ["adopt group", "state-write"],
  ["adopt grants", "read-only"],
  ["report permissions", "read-only"],
]);

function commandAt(program: Command, path: readonly string[]): Command | undefined {
  let command = program;
  for (const name of path) {
    const child = command.commands.find(
      (candidate) => candidate.name() === name || candidate.aliases().includes(name),
    );
    if (!child) return undefined;
    command = child;
  }
  return command;
}

function argumentSchema(argument: Argument): UiArgumentSchema {
  return {
    name: argument.name(),
    description: argument.description,
    required: argument.required,
    variadic: argument.variadic,
    ...(argument.argChoices ? { choices: [...argument.argChoices] } : {}),
    ...(argument.defaultValue === undefined ? {} : { defaultValue: argument.defaultValue }),
    ...(valueDomainOf(argument) ? { valueDomain: valueDomainOf(argument) } : {}),
  };
}

function optionSchema(option: Option): UiOptionSchema {
  return {
    key: option.attributeName(),
    ...(option.short ? { short: option.short } : {}),
    long: option.long ?? option.flags,
    flags: option.flags,
    description: option.description,
    valueKind: option.required ? "required" : option.optional ? "optional" : "boolean",
    mandatory: option.mandatory,
    negated: option.negate,
    ...(option.argChoices ? { choices: [...option.argChoices] } : {}),
    ...(option.defaultValue === undefined ? {} : { defaultValue: option.defaultValue }),
    ...(valueDomainOf(option) ? { valueDomain: valueDomainOf(option) } : {}),
  };
}

/** Build the executable UI catalog exclusively from the live Commander tree. */
export function commanderUiSchema(program: Command): UiCommandSchema[] {
  const schema: UiCommandSchema[] = [];
  for (const [pathText, risk] of ALLOWED) {
    const path = pathText.split(" ");
    const command = commandAt(program, path);
    if (!command) continue;
    schema.push({
      path,
      title: pathText,
      description: command.description(),
      risk,
      arguments: command.registeredArguments.map(argumentSchema),
      options: command.options.map(optionSchema),
    });
  }
  return schema;
}

export function findUiCommand(
  schema: readonly UiCommandSchema[],
  path: readonly string[],
): UiCommandSchema | undefined {
  const key = path.join(" ");
  return schema.find((command) => command.path.join(" ") === key);
}
