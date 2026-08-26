import { Argument, Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { GROUP_VALUE_DOMAIN, withValueDomain } from "../src/command-metadata/value-domain.js";
import { suggestFromContext } from "../src/suggestions/service.js";
import { buildProgram } from "../src/index.js";

describe("generic suggestions", () => {
  it("always wraps structural Commander candidates as value/label pairs", async () => {
    const result = await suggestFromContext(buildProgram(), "adopt ", undefined, {
      cwd: "/process",
      runner: vi.fn(),
    });

    expect(result).toEqual({
      suggestions: expect.arrayContaining([
        { value: "grants", label: expect.stringMatching(/^grants — /) },
        { value: "group", label: expect.stringMatching(/^group — /) },
      ]),
    });
  });

  it("uses parameter value-domain metadata without command-specific suggestion code", async () => {
    const program = new Command("ct").addCommand(
      new Command("pick").addArgument(
        withValueDomain(new Argument("[groups...]", "groups"), GROUP_VALUE_DOMAIN),
      ),
    );
    const runner = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify([
        { id: 17, name: "Jugend" },
        { id: 23, name: "Kinder" },
      ]),
      stderr: "",
      truncated: false,
    }));

    await expect(
      suggestFromContext(program, "ct pick jug", "test", { cwd: "/process", runner }),
    ).resolves.toEqual({ suggestions: [{ value: "17", label: "Jugend · #17" }] });
    expect(runner).toHaveBeenCalledWith(["get", "groups", "--env", "test"], {
      cwd: "/process",
    });
  });

  it("prints the public ct suggest response as JSON", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await buildProgram().parseAsync(["suggest", "adopt "], { from: "user" });
      const output = write.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(JSON.parse(output)).toEqual({
        suggestions: expect.arrayContaining([
          { value: "grants", label: expect.stringMatching(/^grants — /) },
          { value: "group", label: expect.stringMatching(/^group — /) },
        ]),
      });
    } finally {
      write.mockRestore();
    }
  });
});
