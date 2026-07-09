/**
 * Located config errors & warnings (#52 item C). Every fixture here is written to disk and evaluated
 * through the REAL loader (jiti transpiling TS on the fly) so the `new Error().stack` frame mapping —
 * the load-bearing part — is actually exercised end-to-end, not stubbed.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../src/config/load.js";
import { createContext } from "../src/config/context.js";

const dirs: string[] = [];
function writeConfig(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ct-located-"));
  dirs.push(dir);
  const path = join(dir, "ct.config.ts");
  writeFileSync(path, body);
  return path;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("located unknown-field warning (through the real jiti loader)", () => {
  it("prefixes the warning with the config file basename + line of the declaration", async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    // Line 1 = comment, line 2 = export, line 3 = the campus call → location must be ct.config.ts:3.
    const path = writeConfig(
      [
        "// leading comment",
        "export default (ct) => {",
        '  ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });',
        "};",
        "",
      ].join("\n"),
    );
    try {
      await loadConfig(path);
    } finally {
      spy.mockRestore();
    }
    const msg = writes.join("");
    expect(msg).toContain(`${basename(path)}:3 — campus "mainz": unknown field "shortName" (ignored)`);
  });
});

describe("located validation error (through the real jiti loader)", () => {
  it("prefixes an eval-time error with the config file basename + line", async () => {
    // The invalid declaration (both `campus` sugar and numeric `campusId`) sits on line 3.
    const path = writeConfig(
      [
        "// header",
        "export default (ct) => {",
        '  ct.group({ key: "g", name: "G", campus: "mainz", campusId: 4 });',
        "};",
        "",
      ].join("\n"),
    );
    await expect(loadConfig(path)).rejects.toThrow(
      new RegExp(`${basename(path).replace(/\./g, "\\.")}:3 — group "g": declare either "campus"`),
    );
  });

  it("locates an error raised from a helper the config calls (first user frame wins)", async () => {
    // ct.group is called from a helper on line 3; the throwing call site is line 3, not the loop.
    const path = writeConfig(
      [
        "export default (ct) => {",
        "  const mk = (k) => ct.group({ key: k, name: k, parents: 123 });",
        '  mk("team");',
        "};",
        "",
      ].join("\n"),
    );
    await expect(loadConfig(path)).rejects.toThrow(
      new RegExp(`${basename(path).replace(/\./g, "\\.")}:2 — group "team": "parents" must be`),
    );
  });
});

describe("graceful fallback when no user frame is identifiable", () => {
  it("omits the location (never crashes) when the stack carries no frames", () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0; // `new Error().stack` now has no frames → captureCallSite returns undefined
    try {
      const { ct } = createContext();
      ct.campus({ key: "mainz", name: "Mainz", shortName: "MZ" });
    } finally {
      Error.stackTraceLimit = originalLimit;
      spy.mockRestore();
    }
    const msg = writes.join("");
    // Bare message, no `file:line — ` prefix, and no thrown error.
    expect(msg).toContain('campus "mainz": unknown field "shortName" (ignored)');
    expect(msg).not.toMatch(/\.ts:\d+ — campus/);
  });

  it("throws a located-free (but intact) error when no frame is identifiable", () => {
    const originalLimit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      const { ct } = createContext();
      expect(() => ct.group({ key: "g", name: "G", campus: "mainz", campusId: 4 })).toThrow(
        /^group "g": declare either "campus"/,
      );
    } finally {
      Error.stackTraceLimit = originalLimit;
    }
  });
});
