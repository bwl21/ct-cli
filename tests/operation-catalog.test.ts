import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/index.js";
import { operationCatalog } from "../src/operations/catalog.js";
import { generateOpenApi } from "../src/server/openapi.js";

function commandAt(path: readonly string[]) {
  let commands = buildProgram().commands;
  let found;
  for (const segment of path) {
    found = commands.find((command) => command.name() === segment || command.aliases().includes(segment));
    if (!found) return undefined;
    commands = found.commands;
  }
  return found;
}

describe("transport-neutral operation catalog", () => {
  it("projects every non-adapter-specific operation through CLI and HTTP", () => {
    for (const operation of operationCatalog.filter((candidate) => !candidate.adapterSpecific)) {
      expect(operation.cli, operation.id).toBeDefined();
      expect(operation.http?.length, operation.id).toBeGreaterThan(0);
    }
  });

  it("constructs every declared CLI command path", () => {
    for (const operation of operationCatalog.filter((candidate) => candidate.cli)) {
      expect(
        commandAt(operation.cli!.path),
        `${operation.id}: ${operation.cli!.path.join(" ")}`,
      ).toBeDefined();
    }
  });

  it("mechanically validates declared CLI parameter bindings", () => {
    for (const operation of operationCatalog.filter((candidate) => candidate.cli)) {
      const command = commandAt(operation.cli!.path)!;
      for (const parameter of operation.parameters.filter((candidate) => candidate.cli)) {
        if (parameter.cli!.kind === "option") {
          expect(
            command.options.some((option) => option.long === parameter.cli!.name),
            `${operation.id}.${parameter.name}: ${parameter.cli!.name}`,
          ).toBe(true);
        } else {
          expect(
            command.registeredArguments.some((argument) => argument.name() === parameter.cli!.name),
            `${operation.id}.${parameter.name}: ${parameter.cli!.name}`,
          ).toBe(true);
        }
      }
    }
  });

  it("declares every HTTP projection in generated OpenAPI", () => {
    const document = generateOpenApi() as { paths: Record<string, Record<string, { operationId: string }>> };
    for (const operation of operationCatalog) {
      for (const route of operation.http ?? []) {
        const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        expect(document.paths[path]?.[route.method.toLowerCase()]?.operationId).toBe(
          route.action ? `${operation.id}.${route.action}` : operation.id,
        );
      }
    }
  });

  it("keeps sensitive parameters out of URL bindings", () => {
    for (const operation of operationCatalog) {
      for (const parameter of operation.parameters.filter((candidate) => candidate.sensitive)) {
        expect(parameter.http?.in, `${operation.id}.${parameter.name}`).toBe("body");
      }
    }
  });
});
