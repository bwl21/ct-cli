import { describe, it, expect } from "vitest";
import { buildProgram } from "../src/index.js";

describe("ct program", () => {
  it("registers the core command surface", () => {
    const names = buildProgram().commands.map((c) => c.name());
    expect(names).toEqual(expect.arrayContaining(["auth", "get", "adopt", "plan", "apply", "destroy"]));
  });

  it("exposes auth subcommands", () => {
    const auth = buildProgram().commands.find((c) => c.name() === "auth");
    const subs = auth?.commands.map((c) => c.name()) ?? [];
    expect(subs).toEqual(expect.arrayContaining(["login", "status", "logout"]));
  });
});
