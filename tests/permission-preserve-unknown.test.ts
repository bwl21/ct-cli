/**
 * Opt-in partial grant ownership (#102).
 *
 * A `ct.groupRole` normally owns its whole role instance: every live grant absent from the
 * declaration lands in `toDelete`. On a real instance that costs most of the estate — one
 * `cc_html_template` grant makes a 41-grant role undeclarable, because a partial declaration turns a
 * clean no-op into a destructive plan. `preserveUnknown` is the deliberate way out; these tests pin
 * that it is opt-in, that it is loud, and that the strict default did not move.
 */
import { describe, it, expect } from "vitest";
import { diffGrants, type GrantTuple } from "../src/permissions/grants.js";
import { preservePredicateFor } from "../src/permissions/plan.js";
import { renderPermissionPlan } from "../src/permissions/render.js";
import { createContext } from "../src/config/context.js";

/** `churchcore:use church html templates` — scoped by `cc_html_template`, the real-world blocker. */
const HTML_TEMPLATE = 17;
/** `churchgroup:view group` — scoped by `cdb_gruppe`, a dimension this tool DOES manage. */
const VIEW_GROUP = 1104;
/** `churchcore:administer settings` — unscoped. */
const UNSCOPED = 1;

const grant = (authId: number, dataId: number[] = []): GrantTuple => ({ authId, dataId, type: "grant" });

describe("preserveUnknown — the diff (#102)", () => {
  const desired = [grant(VIEW_GROUP, [42])];
  const actual = [grant(VIEW_GROUP, [42]), grant(HTML_TEMPLATE, [3]), grant(VIEW_GROUP, [99])];

  it("default is unchanged: every undeclared live grant is still a revoke", () => {
    const d = diffGrants(desired, actual);
    expect(d.toDelete.map((t) => t.authId)).toEqual([HTML_TEMPLATE, VIEW_GROUP]);
    expect(d.preservedUnknown).toEqual([]);
  });

  it("preserveUnknown: true keeps every undeclared grant instead of revoking it", () => {
    const d = diffGrants(desired, actual, preservePredicateFor(true));
    expect(d.toDelete).toEqual([]);
    expect(d.preservedUnknown.map((t) => t.authId)).toEqual([HTML_TEMPLATE, VIEW_GROUP]);
  });

  it("a dimension list keeps ONLY that dimension — a stray grant on a managed one is still drift", () => {
    const d = diffGrants(desired, actual, preservePredicateFor(["cc_html_template"]));
    // The module grant is left alone…
    expect(d.preservedUnknown.map((t) => t.authId)).toEqual([HTML_TEMPLATE]);
    // …while the unexpected extra group-scoped grant still shows up as something apply will revoke.
    // That is the whole reason to prefer the list form over `true`.
    expect(d.toDelete.map((t) => [t.authId, t.dataId])).toEqual([[VIEW_GROUP, [99]]]);
  });

  it("a dimension list never silently widens to unscoped rights", () => {
    const d = diffGrants([], [grant(UNSCOPED)], preservePredicateFor(["cc_html_template"]));
    expect(d.preservedUnknown).toEqual([]);
    expect(d.toDelete.map((t) => t.authId)).toEqual([UNSCOPED]);
  });

  it("preserved grants are never mistaken for a pre-existing deny row", () => {
    const deny: GrantTuple = { authId: VIEW_GROUP, dataId: [7], type: "revoke" };
    const d = diffGrants(desired, [...actual, deny], preservePredicateFor(true));
    expect(d.preserved).toEqual([deny]); // denies reconciliation never owned
    expect(d.preservedUnknown.every((t) => t.type === "grant")).toBe(true);
  });
});

describe("preserveUnknown — the plan is loud about it (#102)", () => {
  it("renders a role whose ONLY notable property is preserved grants, and excludes them from the totals", () => {
    const rendered = renderPermissionPlan([
      {
        key: "team_office_leiter",
        domainType: "group_role",
        domainId: 44675,
        diff: {
          toPut: [],
          toDelete: [],
          preserved: [],
          preservedUnknown: [grant(HTML_TEMPLATE, [3]), grant(HTML_TEMPLATE, [4])],
        },
      },
    ]);
    // Invisible is exactly what this must not be: without the item line, "I forgot one" and "I
    // deliberately left the module grants alone" render identically (as nothing).
    expect(rendered).toContain("team_office_leiter");
    expect(rendered).toContain("preserved, not managed — preserveUnknown");
    expect(rendered).toContain("0 to grant, 0 to remove, 2 preserved (not managed)");
  });

  it("still reports a clean no-op when nothing at all was preserved", () => {
    const rendered = renderPermissionPlan([
      {
        key: "k",
        domainType: "group_role",
        domainId: 1,
        diff: { toPut: [], toDelete: [], preserved: [], preservedUnknown: [] },
      },
    ]);
    expect(rendered).toContain("No permission changes");
  });
});

describe("preserveUnknown — config validation (#102)", () => {
  const declare = (preserveUnknown: unknown): void => {
    const { ct } = createContext();
    ct.groupRole({
      key: "k",
      id: 1,
      grants: ["churchcore:administer settings"],
      preserveUnknown: preserveUnknown as never,
    });
  };

  it("accepts true and a list of real scope dimensions", () => {
    expect(() => declare(true)).not.toThrow();
    expect(() => declare(["cc_html_template", "cdb_gruppe"])).not.toThrow();
  });

  it("rejects a dimension no right is scoped by — a typo must not read as 'nothing to preserve'", () => {
    expect(() => declare(["cc_html_templates"])).toThrow(/no right in the permission catalog scopes by/);
  });

  it("rejects an empty list rather than accept a no-op escape hatch", () => {
    expect(() => declare([])).toThrow(/preserves nothing/);
  });

  it("rejects a non-string entry", () => {
    expect(() => declare([42])).toThrow(/must be true or an array of scope dimension names/);
  });

  it("treats false as the strict default and carries nothing through", () => {
    const { ct, permissions } = createContext();
    ct.groupRole({ key: "k", id: 1, grants: [], preserveUnknown: false });
    expect(permissions[0]?.preserveUnknown).toBeUndefined();
  });

  it("carries an accepted value onto the desired permission, deduped", () => {
    const { ct, permissions } = createContext();
    ct.groupRole({
      key: "k",
      id: 1,
      grants: [],
      preserveUnknown: ["cc_html_template", "cc_html_template"],
    });
    expect(permissions[0]?.preserveUnknown).toEqual(["cc_html_template"]);
  });
});
