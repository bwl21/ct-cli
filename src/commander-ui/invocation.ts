import type { UiArgumentSchema, UiCommandSchema, UiOptionSchema } from "./schema.js";

export class UiInputError extends Error {}

export type UiFieldValue = string | string[] | boolean;

export interface UiInvocationInput {
  command: string[];
  arguments?: Record<string, UiFieldValue>;
  options?: Record<string, UiFieldValue>;
  confirmed?: boolean;
}

export interface BuiltInvocation {
  argv: string[];
  reportOutputs: string[];
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UiInputError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function selectedString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === false || value === "") return undefined;
  if (typeof value !== "string") throw new UiInputError(`${name} must be a string.`);
  return value;
}

function validateChoice(value: string, choices: readonly string[] | undefined, name: string): void {
  if (choices && !choices.includes(value)) {
    throw new UiInputError(`${name} must be one of: ${choices.join(", ")}.`);
  }
}

function argumentValues(argument: UiArgumentSchema, value: unknown): string[] {
  if (argument.variadic) {
    if (value === undefined) {
      if (argument.required) throw new UiInputError(`Argument ${argument.name} is required.`);
      return [];
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "")) {
      throw new UiInputError(`Argument ${argument.name} must be an array of non-empty strings.`);
    }
    for (const entry of value as string[]) validateChoice(entry, argument.choices, argument.name);
    return value as string[];
  }
  const selected = selectedString(value, `Argument ${argument.name}`);
  if (selected === undefined) {
    if (argument.required) throw new UiInputError(`Argument ${argument.name} is required.`);
    return [];
  }
  validateChoice(selected, argument.choices, argument.name);
  return [selected];
}

function optionValues(option: UiOptionSchema, value: unknown): string[] {
  if (option.valueKind === "boolean") {
    if (value === undefined || value === false) return [];
    if (value !== true) throw new UiInputError(`Option ${option.long} must be true or false.`);
    return [option.long];
  }
  if (option.valueKind === "optional" && value === true) return [option.long];
  const selected = selectedString(value, `Option ${option.long}`);
  if (selected === undefined) {
    if (option.mandatory) throw new UiInputError(`Option ${option.long} is required.`);
    return [];
  }
  validateChoice(selected, option.choices, option.long);
  return [option.long, selected];
}

function assertKnownKeys(values: Record<string, unknown>, allowed: readonly string[], kind: string): void {
  const unknown = Object.keys(values).find((key) => !allowed.includes(key));
  if (unknown) throw new UiInputError(`Unknown ${kind}: ${unknown}.`);
}

/** Reconstruct argv from known schema fields. Raw argv is never accepted from the browser. */
export function buildUiInvocation(command: UiCommandSchema, raw: unknown): BuiltInvocation {
  const input = record(raw, "request");
  assertKnownKeys(input, ["command", "arguments", "options", "confirmed"], "request field");
  const path = input.command;
  if (!Array.isArray(path) || path.some((part) => typeof part !== "string")) {
    throw new UiInputError("command must be an array of strings.");
  }
  if (path.join(" ") !== command.path.join(" ")) throw new UiInputError("Command path mismatch.");
  if (command.risk === "state-write" && input.confirmed !== true) {
    throw new UiInputError("This state-changing command must be confirmed.");
  }

  const argumentsRecord = record(input.arguments, "arguments");
  const optionsRecord = record(input.options, "options");
  assertKnownKeys(
    argumentsRecord,
    command.arguments.map((argument) => argument.name),
    "argument",
  );
  assertKnownKeys(
    optionsRecord,
    command.options.map((option) => option.key),
    "option",
  );

  const positional = command.arguments.flatMap((argument) =>
    argumentValues(argument, argumentsRecord[argument.name]),
  );
  const options = command.options.flatMap((option) => optionValues(option, optionsRecord[option.key]));
  const reportOutputs =
    command.path.join(" ") === "report permissions"
      ? [
          optionsRecord.bySubject === true ? "permissions-by-subject.md" : optionsRecord.bySubject,
          optionsRecord.byObject === true ? "permissions-by-object.md" : optionsRecord.byObject,
          optionsRecord.byBoth,
        ].filter((value): value is string => typeof value === "string" && value !== "")
      : [];
  return { argv: [...command.path, ...positional, ...options], reportOutputs };
}

/** Build the already-entered words used by the existing shell-completion engine. */
export function completionWords(
  command: UiCommandSchema,
  rawArguments: unknown,
  rawOptions: unknown,
  field: { kind: "argument" | "option"; name: string },
): string[] {
  const args = record(rawArguments, "arguments");
  const opts = record(rawOptions, "options");
  const words = ["ct", ...command.path];
  for (const argument of command.arguments) {
    if (field.kind === "argument" && field.name === argument.name) break;
    const value = args[argument.name];
    if (typeof value === "string" && value !== "") words.push(value);
    if (Array.isArray(value))
      words.push(...value.filter((entry): entry is string => typeof entry === "string"));
  }
  for (const option of command.options) {
    if (field.kind === "option" && field.name === option.key) continue;
    const value = opts[option.key];
    if (value === true) words.push(option.long);
    else if (typeof value === "string" && value !== "") words.push(option.long, value);
  }
  if (field.kind === "option") {
    const option = command.options.find((candidate) => candidate.key === field.name);
    if (!option || option.valueKind === "boolean") throw new UiInputError("Unknown value-taking option.");
    words.push(option.long);
  } else if (!command.arguments.some((argument) => argument.name === field.name)) {
    throw new UiInputError("Unknown argument.");
  }
  return words;
}
