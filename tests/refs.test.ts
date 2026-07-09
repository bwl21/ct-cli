import { describe, it, expect } from "vitest";
import {
  ref,
  isRef,
  isPendingRef,
  pendingRef,
  refKey,
  refLabel,
  deepMapRefs,
  collectRefs,
  hasPendingRef,
} from "../src/resolve/refs.js";

describe("ref helper", () => {
  it("builds the expected sentinels", () => {
    expect(ref.campus("mainz")).toEqual({ __ctRef: true, kind: "campus", key: "mainz" });
    expect(ref.groupType("mt")).toEqual({ __ctRef: true, kind: "group-type", key: "mt" });
    expect(ref.status("active")).toEqual({ __ctRef: true, kind: "group-status", key: "active" });
    expect(ref.roleDef("leiter")).toEqual({ __ctRef: true, kind: "role-def", key: "leiter" });
    expect(ref.group("g")).toEqual({ __ctRef: true, kind: "group", key: "g" });
    expect(ref.groupRole("g", "Leiter")).toEqual({ __ctRef: true, kind: "group-role", group: "g", role: "Leiter" });
  });

  it("rejects an empty/non-string key", () => {
    expect(() => ref.campus("")).toThrow(/non-empty string/);
    expect(() => ref.campus(4 as never)).toThrow(/non-empty string/);
    expect(() => ref.groupRole("g", "")).toThrow(/non-empty string/);
  });
});

describe("isRef", () => {
  it("recognises refs and rejects plain values", () => {
    expect(isRef(ref.campus("x"))).toBe(true);
    expect(isRef({ kind: "campus", key: "x" })).toBe(false); // missing __ctRef
    expect(isRef(4)).toBe(false);
    expect(isRef(null)).toBe(false);
    expect(isRef("campus")).toBe(false);
  });
});

describe("refKey / refLabel", () => {
  it("keys simple and compound refs distinctly", () => {
    expect(refKey(ref.campus("mainz"))).toBe("campus:mainz");
    expect(refKey(ref.groupRole("g", "r"))).toBe("group-role:g r");
    expect(refLabel(ref.groupType("mt"))).toBe("group-type:mt");
    expect(refLabel(ref.groupRole("g", "r"))).toBe("group-role(group=g, role=r)");
  });
});

describe("pendingRef / isPendingRef", () => {
  it("wraps and recognises a pending marker", () => {
    const p = pendingRef(ref.campus("mainz"));
    expect(p).toEqual({ __pendingRef: { __ctRef: true, kind: "campus", key: "mainz" } });
    expect(isPendingRef(p)).toBe(true);
    expect(isPendingRef(ref.campus("mainz"))).toBe(false); // a bare ref is not pending
    expect(isPendingRef({ __pendingRef: 4 })).toBe(false); // must wrap a real ref
    expect(isPendingRef(4)).toBe(false);
  });
});

describe("deepMapRefs", () => {
  it("replaces refs anywhere in a nested structure, passing scalars through", () => {
    const input = {
      campusId: ref.campus("mainz"),
      query: { "==": [{ var: "ctgroup.campusId" }, ref.campus("berlin")], n: 5, s: "x" },
      list: [1, ref.groupType("mt"), "keep"],
    };
    const out = deepMapRefs(input, (r) => refKey(r));
    expect(out).toEqual({
      campusId: "campus:mainz",
      query: { "==": [{ var: "ctgroup.campusId" }, "campus:berlin"], n: 5, s: "x" },
      list: [1, "group-type:mt", "keep"],
    });
  });

  it("returns scalars untouched", () => {
    expect(deepMapRefs(5, () => 0)).toBe(5);
    expect(deepMapRefs("x", () => 0)).toBe("x");
    expect(deepMapRefs(null, () => 0)).toBe(null);
  });
});

describe("collectRefs", () => {
  it("gathers every ref in order, treating refs as leaves", () => {
    const refs = collectRefs({ a: ref.campus("x"), b: [ref.groupType("y"), { c: ref.group("z") }], d: 4 });
    expect(refs.map(refKey)).toEqual(["campus:x", "group-type:y", "group:z"]);
  });

  it("returns [] when there are no refs (the numeric escape hatch)", () => {
    expect(collectRefs({ campusId: 4, groupTypeId: 2 })).toEqual([]);
  });
});

describe("hasPendingRef", () => {
  it("detects a pending marker at any depth", () => {
    expect(hasPendingRef({ campusId: pendingRef(ref.campus("x")) })).toBe(true);
    expect(hasPendingRef({ a: [1, { b: pendingRef(ref.group("g")) }] })).toBe(true);
    expect(hasPendingRef({ campusId: 4, groupTypeId: 2 })).toBe(false);
  });
});
