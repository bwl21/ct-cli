import type { Command } from "commander";
import { valueDomainOf } from "../command-metadata/value-domain.js";
import {
  completionParameter,
  detailedCompletionCandidates,
  splitCompletionLine,
} from "../completion/candidates.js";
import type { CliRunResult, RunCliOptions } from "../runtime/cli-launcher.js";

const MAX_SUGGESTIONS = 100;

export interface Suggestion {
  value: string;
  label: string;
}

export interface SuggestionsResult {
  suggestions: Suggestion[];
}

type Runner = (argv: readonly string[], options: RunCliOptions) => Promise<CliRunResult>;

export interface SuggestionResolverOptions {
  cwd: string;
  runner: Runner;
  cacheMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function label(row: Record<string, unknown>, fields: readonly string[]): string {
  return fields
    .flatMap((field) => {
      const value = row[field];
      if (value === undefined || value === null || value === "") return [];
      return [field === "id" ? `#${String(value)}` : String(value)];
    })
    .join(" · ");
}

function completionParts(context: string): { words: string[]; partial: string } {
  const line = /^\s*ct(?:\s|$)/.test(context) ? context.trimStart() : `ct ${context}`;
  const tokens = line.split(/\s+/).filter(Boolean);
  const fragment = /\s$/.test(line) ? tokens.length : Math.max(0, tokens.length - 1);
  return splitCompletionLine(line, fragment);
}

/**
 * Resolve every kind of suggestion through one stable contract. Commander supplies
 * structural candidates; an optional parameter value-domain supplies live values.
 */
export function createSuggestionResolver(options: SuggestionResolverOptions) {
  const cache = new Map<string, { expires: number; suggestions: Suggestion[] }>();

  return async function resolveSuggestions(
    program: Command,
    words: string[],
    partial: string,
    environment?: string,
  ): Promise<SuggestionsResult> {
    const parameter = completionParameter(program, words, partial);
    const domain = parameter ? valueDomainOf(parameter) : undefined;
    if (!domain) {
      return { suggestions: await detailedCompletionCandidates(program, words, partial) };
    }

    const argv = [...domain.source.command];
    if (environment) argv.push("--env", environment);
    const cacheKey = JSON.stringify(argv);
    let cached = cache.get(cacheKey);
    if (!cached || cached.expires < Date.now()) {
      const result = await options.runner(argv, { cwd: options.cwd });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Suggestion source exited ${result.exitCode}.`);
      }
      const rows: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(rows)) throw new Error("Suggestion source did not return a JSON array.");
      cached = {
        expires: Date.now() + (options.cacheMs ?? 0),
        suggestions: rows.flatMap((value): Suggestion[] => {
          const row = record(value);
          const selected = row[domain.source.valueField];
          if (typeof selected !== "string" && typeof selected !== "number") return [];
          const normalized = String(selected);
          return [{ value: normalized, label: label(row, domain.source.labelFields) || normalized }];
        }),
      };
      cache.set(cacheKey, cached);
    }

    const needle = partial.toLocaleLowerCase();
    return {
      suggestions: cached.suggestions
        .filter(
          (suggestion) =>
            needle === "" ||
            suggestion.value.toLocaleLowerCase().includes(needle) ||
            suggestion.label.toLocaleLowerCase().includes(needle),
        )
        .slice(0, MAX_SUGGESTIONS),
    };
  };
}

export async function suggestFromContext(
  program: Command,
  context: string,
  environment: string | undefined,
  options: SuggestionResolverOptions,
): Promise<SuggestionsResult> {
  const { words, partial } = completionParts(context);
  return createSuggestionResolver(options)(program, words, partial, environment);
}
