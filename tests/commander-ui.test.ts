import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { completionCandidates } from "../src/completion/candidates.js";
import { buildUiInvocation, completionWords, UiInputError } from "../src/commander-ui/invocation.js";
import { resolveCliLaunchTarget } from "../src/runtime/cli-launcher.js";
import { commanderUiSchema, findUiCommand } from "../src/commander-ui/schema.js";
import { buildProgram } from "../src/index.js";

describe("Commander-generated UI schema", () => {
  it("projects the allowed command tree including arguments and options", () => {
    const schema = commanderUiSchema(buildProgram());
    expect(schema.map((command) => command.path.join(" "))).toEqual([
      "adopt",
      "adopt group",
      "adopt grants",
      "report permissions",
    ]);
    const adopt = findUiCommand(schema, ["adopt"])!;
    expect(adopt.risk).toBe("state-write");
    expect(adopt.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "type", required: true }),
        expect.objectContaining({ name: "id", required: true }),
      ]),
    );
    expect(adopt.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "env", long: "--env", valueKind: "required" }),
        expect.objectContaining({ key: "dryRun", long: "--dry-run", valueKind: "boolean" }),
      ]),
    );
    const adoptGroup = findUiCommand(schema, ["adopt", "group"])!;
    expect(adoptGroup.arguments[0]?.valueDomain).toMatchObject({
      purpose: "parameter-value-domain",
      constraint: "suggestions",
      source: { command: ["get", "groups"], valueField: "id" },
    });
  });

  it("automatically reflects a new Commander option without a form definition", () => {
    const program = new Command("ct");
    program.addCommand(
      new Command("adopt")
        .description("Adopt")
        .argument("<type>", "type")
        .argument("<id>", "id")
        .option("--new-choice <value>", "new", undefined)
        .action(() => undefined),
    );
    const adopt = commanderUiSchema(program)[0]!;
    expect(adopt.options).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "newChoice", long: "--new-choice" })]),
    );
  });
});

describe("UI invocation validation", () => {
  const schema = commanderUiSchema(buildProgram());

  it("builds argv without joining user values into shell text", () => {
    const adopt = findUiCommand(schema, ["adopt"])!;
    const result = buildUiInvocation(adopt, {
      command: ["adopt"],
      arguments: { type: "group", id: "7; touch /tmp/nope" },
      options: { env: "test", dryRun: true },
      confirmed: true,
    });
    expect(result.argv).toEqual(["adopt", "group", "7; touch /tmp/nope", "--env", "test", "--dry-run"]);
  });

  it("supports optional report values and records their paths", () => {
    const report = findUiCommand(schema, ["report", "permissions"])!;
    expect(
      buildUiInvocation(report, {
        command: ["report", "permissions"],
        options: { bySubject: "reports/subject.md", byObject: true },
      }),
    ).toEqual({
      argv: ["report", "permissions", "--by-subject", "reports/subject.md", "--by-object"],
      reportOutputs: ["reports/subject.md", "permissions-by-object.md"],
    });
  });

  it("requires confirmation and rejects unknown fields", () => {
    const adopt = findUiCommand(schema, ["adopt"])!;
    expect(() =>
      buildUiInvocation(adopt, {
        command: ["adopt"],
        arguments: { type: "group", id: "7" },
      }),
    ).toThrow(/must be confirmed/);
    expect(() =>
      buildUiInvocation(adopt, {
        command: ["adopt"],
        arguments: { type: "group", id: "7" },
        options: { arbitrary: "value" },
        confirmed: true,
      }),
    ).toThrow(UiInputError);
    expect(() =>
      buildUiInvocation(adopt, {
        command: ["adopt"],
        arguments: { type: "group", id: "7" },
        confirmed: true,
        argv: ["apply", "--auto-approve"],
      }),
    ).toThrow(/Unknown request field: argv/);
  });

  it("feeds the existing completion engine with structured form state", async () => {
    const adopt = findUiCommand(schema, ["adopt"])!;
    const words = completionWords(adopt, {}, {}, { kind: "argument", name: "type" });
    await expect(completionCandidates(buildProgram(), words, "")).resolves.toContain("group");
  });
});

describe("CLI launch target", () => {
  it("prefixes a Node or source entrypoint", () => {
    expect(
      resolveCliLaunchTarget("/usr/bin/node", ["node", "/repo/src/index.ts", "ui"], ["--import", "tsx"]),
    ).toEqual({
      executable: "/usr/bin/node",
      prefix: ["--import", "tsx", "/repo/src/index.ts"],
    });
  });

  it("reuses a compiled executable directly", () => {
    expect(resolveCliLaunchTarget("/opt/ct", ["/opt/ct", "ui"], [])).toEqual({
      executable: "/opt/ct",
      prefix: [],
    });
  });
});
