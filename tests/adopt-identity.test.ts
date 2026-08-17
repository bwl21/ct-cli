/**
 * Adoption identity: a re-adopt refreshes the SNAPSHOT, not the KEY (#123), and there is a supported
 * way back out of an adoption (#122).
 *
 * `ct adopt group <id…> --with-dynamic` is the documented ruleset-refresh workflow and takes a LIST
 * of ids — the one mode where `-k` is rejected — so any resource whose adopted key differed from the
 * derived key was silently re-keyed by a routine refresh. The config's declaration then matched
 * nothing in state, and the next plan read "one to create, one to destroy" for a resource that was
 * fine and untouched on the host. Recovering meant hand-editing the state file, which had no
 * supported command either.
 */
import { describe, it, expect } from "vitest";
import { chooseAdoptKey, emptyState, upsert, type State } from "../src/state/state.js";

const HOST = "https://mychurch.church.tools";

/** State holding one group adopted long ago under a deliberately-chosen key. */
function adopted(): State {
  const state = emptyState(HOST);
  state.resources.merkmal_alle_2_5_mz = {
    type: "group",
    id: 1990,
    key: "merkmal_alle_2_5_mz",
    fields: { name: "Alle 2 bis 5 MZ" },
    adoptedAt: "t",
    updatedAt: "t",
  };
  return state;
}

describe("re-adopting keeps the adopted key (#123)", () => {
  it("keeps the existing key when the derived one differs, and reports what it would have been", () => {
    const choice = chooseAdoptKey(adopted(), "group", 1990, "alle_2_bis_5_mz");
    expect(choice.key).toBe("merkmal_alle_2_5_mz");
    expect(choice.wouldBecome).toBe("alle_2_bis_5_mz");
  });

  it("re-keys only when --rekey is passed explicitly", () => {
    const choice = chooseAdoptKey(adopted(), "group", 1990, "alle_2_bis_5_mz", { rekey: true });
    expect(choice.key).toBe("alle_2_bis_5_mz");
    expect(choice.wouldBecome).toBeUndefined();
  });

  it("says nothing when the derived key already matches", () => {
    const choice = chooseAdoptKey(adopted(), "group", 1990, "merkmal_alle_2_5_mz");
    expect(choice).toEqual({ key: "merkmal_alle_2_5_mz" });
  });

  it("an explicit --key still wins — it is an explicit intent, not a derivation", () => {
    const choice = chooseAdoptKey(adopted(), "group", 1990, "alle_2_bis_5_mz", {
      explicitKey: "something_else",
    });
    expect(choice.key).toBe("something_else");
  });

  it("a NEW resource just takes the derived key", () => {
    const choice = chooseAdoptKey(adopted(), "group", 4242, "brand_new");
    expect(choice).toEqual({ key: "brand_new" });
  });

  it("does not confuse a same id of a different TYPE", () => {
    // Ids are unique only within a type — the Mainz campus is id 0. A campus #1990 must not inherit
    // the group's key.
    expect(chooseAdoptKey(adopted(), "campus", 1990, "derived")).toEqual({ key: "derived" });
  });

  it("the preserved key is what state ends up keyed by — no second entry, no orphan", () => {
    const state = adopted();
    const choice = chooseAdoptKey(state, "group", 1990, "alle_2_bis_5_mz");
    upsert(state, { type: "group", id: 1990, key: choice.key, fields: { name: "Alle 2 bis 5 MZ" } }, "n");
    expect(Object.keys(state.resources)).toEqual(["merkmal_alle_2_5_mz"]);
    expect(state.resources.merkmal_alle_2_5_mz?.id).toBe(1990);
    // The stale-file half of the bug: the ruleset path is built from this key, so preserving it means
    // the refresh overwrites rulesets/merkmal_alle_2_5_mz.json instead of writing a second file.
    expect(`rulesets/${choice.key}.json`).toBe("rulesets/merkmal_alle_2_5_mz.json");
  });

  it("still re-keys through upsert when --rekey was given (no orphan left behind)", () => {
    const state = adopted();
    const choice = chooseAdoptKey(state, "group", 1990, "alle_2_bis_5_mz", { rekey: true });
    upsert(state, { type: "group", id: 1990, key: choice.key, fields: { name: "x" } }, "n");
    expect(Object.keys(state.resources)).toEqual(["alle_2_bis_5_mz"]);
  });
});
