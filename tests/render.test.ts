import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type pcType from "picocolors";
import { renderPlan } from "../src/engine/render.js";

describe("renderPlan", () => {
  it("reports no changes for an empty or all-no-op plan", () => {
    expect(renderPlan({ items: [] })).toMatch(/No changes/);
    expect(
      renderPlan({ items: [{ type: "campus", key: "mz", id: 0, action: "no-op", changes: [] }] }),
    ).toMatch(/No changes/);
  });

  it("renders create/update lines and a summary", () => {
    const out = renderPlan({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz" }],
        },
        {
          type: "group",
          key: "kids",
          id: 7,
          action: "update",
          changes: [{ field: "name", from: "K", to: "Kids" }],
        },
      ],
    });
    expect(out).toMatch(/campus\.mainz/);
    expect(out).toMatch(/group\.kids/);
    expect(out).toMatch(/1 to create, 1 to update/);
  });

  it("surfaces drift", () => {
    const out = renderPlan({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: 0,
          action: "no-op",
          changes: [],
          drift: [{ field: "shortName", from: "MZ", to: "CHANGED" }],
        },
      ],
    });
    expect(out).toMatch(/Drift detected/);
    expect(out).toMatch(/shortName/);
  });

  it("surfaces stale state entries instead of reporting no changes", () => {
    const out = renderPlan({
      items: [{ type: "campus", key: "old", id: 9, action: "no-op", changes: [], note: "stale" }],
    });
    expect(out).not.toMatch(/No changes/);
    expect(out).toMatch(/Stale state entries/);
    expect(out).toMatch(/campus\.old/);
  });

  it("surfaces unresolved types", () => {
    const out = renderPlan({
      items: [{ type: "age-group", key: "ag", id: 3, action: "no-op", changes: [], note: "unresolved-type" }],
    });
    expect(out).not.toMatch(/No changes/);
    expect(out).toMatch(/Unresolved types/);
    expect(out).toMatch(/age-group\.ag/);
  });

  it("marks a recreate", () => {
    const out = renderPlan({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz" }],
          note: "recreate",
        },
      ],
    });
    expect(out).toMatch(/recreate/);
  });
});

// PR-comment rendering (#24): a plan pasted into a GitHub `<details>` block must read cleanly with
// no ANSI at all. picocolors decides at MODULE LOAD time whether color is enabled (NO_COLOR /
// non-TTY / --no-color turn it off) and is externalized by vitest, so flipping `process.env` here
// cannot re-evaluate it — and the ambient CI env var would force color ON on a runner anyway.
// Instead, mock it with its own `createColors(false)` — the exact object it exports when NO_COLOR
// is set — and dynamically re-import render.js against that.
describe("renderPlan without color support (NO_COLOR / non-TTY, #24)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("picocolors", async (importOriginal) => {
      const orig = await importOriginal<{ default: typeof pcType }>();
      return { default: orig.default.createColors(false) };
    });
  });

  afterEach(() => {
    vi.doUnmock("picocolors");
    vi.resetModules();
  });

  it("emits no ANSI escape codes and keeps the +/~/-/! prefixes as the sole signal", async () => {
    const { renderPlan: renderPlanNoColor } = await import("../src/engine/render.js");
    const out = renderPlanNoColor({
      items: [
        {
          type: "campus",
          key: "mainz",
          id: null,
          action: "create",
          changes: [{ field: "name", from: undefined, to: "Mainz" }],
        },
        {
          type: "group",
          key: "kids",
          id: 7,
          action: "update",
          changes: [{ field: "name", from: "K", to: "Kids" }],
        },
        {
          type: "group",
          key: "area",
          id: 3,
          action: "delete",
          changes: [],
        },
        {
          type: "campus",
          key: "drifted",
          id: 9,
          action: "no-op",
          changes: [],
          drift: [{ field: "shortName", from: "MZ", to: "CHANGED" }],
        },
      ],
    });
    // eslint-disable-next-line no-control-regex -- asserting the ABSENCE of ANSI escape sequences
    expect(out).not.toMatch(/\x1b\[/);
    expect(out).toMatch(/^\s*\+ campus\.mainz/m);
    expect(out).toMatch(/^\s*~ group\.kids/m);
    expect(out).toMatch(/^\s*- group\.area/m);
    expect(out).toMatch(/^\s*! campus\.drifted.*shortName/m);
  });
});
