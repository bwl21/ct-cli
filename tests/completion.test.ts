/**
 * Shell completion (#132).
 *
 * `ct` installs a shell hook that calls back into `ct` on every Tab, so the thing
 * worth testing is not a generated script but the answer this process gives for a
 * command line. Two properties are load-bearing:
 *
 * - **Completion is offline.** It may read the local config repo and nothing else —
 *   no ChurchTools call, no credential, no `prepareEnv`. The session module is mocked
 *   to throw so that any accidental route to the network fails the suite.
 * - **Completion never errors and never hangs.** A missing or malformed file is the
 *   normal state of a config repo mid-edit; it must degrade to no candidates.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command, Option } from "commander";

const authedSession = vi.fn(async () => {
  throw new Error("completion must never contact ChurchTools");
});
vi.mock("../src/api/session.js", () => ({ authedSession }));

const { completionCandidates, splitCompletionLine } = await import("../src/completion/candidates.js");
const { COMPLETION_SHELLS, completionScript, isCompletionRequest } =
  await import("../src/completion/shell.js");
const { buildProgram } = await import("../src/index.js");

/** A stand-in for the real tree, so the structural assertions do not move with the CLI. */
function representativeProgram(): Command {
  const permissions = new Command("permissions")
    .description("Render permission reports")
    .option("--by-subject", "group permissions by subject")
    .option("-o, --output <path>", "write the report to a file")
    .addOption(new Option("--format <format>", "output format").choices(["json", "markdown"]));
  const program = new Command("ct").option("-e, --env <name>", "environment profile from ct.envs.json");
  program.addCommand(new Command("report").description("Generate reports").addCommand(permissions));
  return program;
}

/** Complete the given command line, splitting it the way a shell hook would. */
async function complete(program: Command, line: string): Promise<string[]> {
  const tokens = line.split(/\s+/).filter(Boolean);
  // The shells report the index of the word under the cursor; a trailing space means
  // a new, empty word, which is one index past the last typed token.
  const fragment = /\s$/.test(line) ? tokens.length : tokens.length - 1;
  const { words, partial } = splitCompletionLine(line, fragment);
  return completionCandidates(program, words, partial);
}

describe("completion candidates", () => {
  it("offers top-level commands", async () => {
    expect(await complete(representativeProgram(), "ct ")).toEqual(["report", "help"]);
  });

  it("descends into nested subcommands", async () => {
    expect(await complete(representativeProgram(), "ct report ")).toContain("permissions");
  });

  it("offers a command's options once a dash is typed", async () => {
    const candidates = await complete(representativeProgram(), "ct report permissions -");
    expect(candidates).toEqual(expect.arrayContaining(["--by-subject", "-o", "--output", "--format"]));
  });

  it("offers the enumerated values of an option", async () => {
    const candidates = await complete(representativeProgram(), "ct report permissions --format ");
    expect(candidates).toEqual(["json", "markdown"]);
  });

  it("offers the enumerated values of an argument", async () => {
    expect(await complete(buildProgram(), "ct completion ")).toEqual([...COMPLETION_SHELLS]);
  });

  it("does not mistake an option value for a positional word", async () => {
    // `markdown` must be consumed as --format's value, so this still completes the
    // command's own arguments rather than treating it as one.
    const candidates = await complete(representativeProgram(), "ct report permissions --format markdown ");
    expect(candidates).toEqual([]);
  });

  it("reflects the real command tree, nested commands included", async () => {
    const program = buildProgram();
    expect(await complete(program, "ct ")).toEqual(
      expect.arrayContaining(["auth", "state", "plan", "apply", "destroy", "completion"]),
    );
    expect(await complete(program, "ct auth ")).toEqual(expect.arrayContaining(["login", "logout"]));
    expect(await complete(program, "ct state ")).toEqual(expect.arrayContaining(["list", "rm"]));
    expect(await complete(program, "ct apply -")).toEqual(expect.arrayContaining(["--auto-approve"]));
  });
});

describe("dynamic completion", () => {
  let dir: string;
  const originalEnvs = process.env.CT_ENVS;
  const originalState = process.env.CT_STATE;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ct-completion-"));
    delete process.env.CT_ENVS;
    delete process.env.CT_STATE;
  });

  afterEach(async () => {
    process.env.CT_ENVS = originalEnvs;
    process.env.CT_STATE = originalState;
    if (originalEnvs === undefined) delete process.env.CT_ENVS;
    if (originalState === undefined) delete process.env.CT_STATE;
    await rm(dir, { recursive: true, force: true });
  });

  it("completes --env with the environments this config repo actually declares", async () => {
    process.env.CT_ENVS = join(dir, "ct.envs.json");
    await writeFile(
      process.env.CT_ENVS,
      JSON.stringify({
        environments: {
          dev: { host: "https://x-dev.church.tools" },
          prod: { host: "https://x.church.tools" },
        },
      }),
    );
    expect(await complete(buildProgram(), "ct plan --env ")).toEqual(["dev", "prod"]);
  });

  it("completes `state rm` with the keys actually under management", async () => {
    process.env.CT_STATE = join(dir, "ct-state.json");
    await writeFile(
      process.env.CT_STATE,
      JSON.stringify({
        version: 1,
        host: "https://x.church.tools",
        resources: { mainz: { type: "campus", id: 1 }, youth: { type: "group", id: 2 } },
      }),
    );
    expect(await complete(buildProgram(), "ct state rm campus ")).toEqual(["mainz", "youth"]);
  });

  it("completes `state rm` with the resource types the registry knows", async () => {
    expect(await complete(buildProgram(), "ct state rm ")).toEqual(
      expect.arrayContaining(["campus", "group", "group-role"]),
    );
  });

  it("completes a path option from the filesystem", async () => {
    await writeFile(join(dir, "ct.config.ts"), "");
    const candidates = await complete(buildProgram(), `ct plan --config ${dir}/ct`);
    expect(candidates).toContain(join(dir, "ct.config.ts"));
  });

  it("degrades to no candidates when a source file is missing or malformed", async () => {
    process.env.CT_ENVS = join(dir, "absent.json");
    expect(await complete(buildProgram(), "ct plan --env ")).toEqual([]);

    process.env.CT_ENVS = join(dir, "broken.json");
    await writeFile(process.env.CT_ENVS, "{ not json");
    expect(await complete(buildProgram(), "ct plan --env ")).toEqual([]);
  });

  it("never contacts ChurchTools", () => {
    expect(authedSession).not.toHaveBeenCalled();
  });
});

describe("splitCompletionLine", () => {
  it("treats the last word as partial when the cursor sits on it", () => {
    expect(splitCompletionLine("ct sta", 1)).toEqual({ words: ["ct"], partial: "sta" });
  });

  it("treats the cursor after a space as a new, empty word", () => {
    expect(splitCompletionLine("ct state ", 2)).toEqual({ words: ["ct", "state"], partial: "" });
  });
});

describe("the installed shell hook", () => {
  it("delegates back to ct rather than baking in a generated script", () => {
    for (const shell of COMPLETION_SHELLS) {
      const script = completionScript(buildProgram(), shell);
      expect(script).toContain("--compgen");
      expect(script).toContain("ct");
      // The whole hook is small because the shell dialect lives in the library, not here.
      expect(script.split("\n").length).toBeLessThan(40);
    }
  });

  it("uses each shell's own registration syntax", () => {
    expect(completionScript(buildProgram(), "zsh")).toContain("compdef");
    expect(completionScript(buildProgram(), "bash")).toContain("complete -F");
    expect(completionScript(buildProgram(), "fish")).toContain("complete -f -c ct");
  });

  it("recognises a Tab keypress by the hook's plumbing flag", () => {
    expect(isCompletionRequest(["node", "ct", "--compbash", "--compgen", "1", "ct", "ct "])).toBe(true);
    expect(isCompletionRequest(["node", "ct", "plan"])).toBe(false);
  });

  it("prints the hook without credentials or a ChurchTools request", async () => {
    let output = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await buildProgram().parseAsync(["completion", "bash"], { from: "user" });
    } finally {
      write.mockRestore();
    }
    expect(output).toContain("complete -F _ct_completion ct");
    expect(authedSession).not.toHaveBeenCalled();
  });
});
