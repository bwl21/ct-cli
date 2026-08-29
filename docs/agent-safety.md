# Agent-Safe Development Policy

This policy defines how AI coding agents may change this repository safely. It complements
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`SECURITY.md`](../SECURITY.md).

The goal is not to require a human to understand every generated line of code. The goal is
to make intended behaviour, risk, and verification explicit enough that changes remain
reviewable and trustworthy.

## 1. State the contract before implementation

Before making a non-trivial change, the agent should state:

- what observable behaviour is intended to change,
- what behaviour must remain unchanged,
- any required backward compatibility,
- the main risks,
- how the change will be verified.

If the domain behaviour is unclear, do not invent it. Ask or leave the ambiguity visible.

## 2. Keep changes narrowly scoped

A change should solve one coherent problem.

Without an explicit reason, do not combine a requested change with:

- unrelated refactoring,
- public API renames,
- configuration format changes,
- dependency replacement,
- removal of backward compatibility.

Small diffs are easier to verify and easier to revert.

## 3. Protect repository invariants

All changes must preserve the invariants already documented in `CONTRIBUTING.md`, in
particular:

- `plan` must report changes honestly,
- a clean `apply` must round-trip to a no-op plan,
- people remain permanently out of scope,
- live writes remain triple-gated and limited to development instances.

For the area being changed, add any further invariants that define correctness. Prefer
logical, host-independent behaviour over host-specific numeric identifiers when the
ChurchTools API exposes a stable technical name or equivalent logical key.

Example for logical group-status resolution:

- configuration by technical name behaves the same on hosts with different numeric IDs,
- existing numeric-ID configuration remains supported for backward compatibility,
- adoption reverse-resolves a known numeric ID to its logical form,
- unknown IDs are preserved or rejected explicitly rather than silently mapped,
- cross-host fixtures prove equivalent behaviour despite different host IDs.

## 4. Tests are executable specification

Every behavioural change must have focused automated verification.

### Bug fix

Add at least one regression test that fails before the fix and passes after it.

### Feature

Cover the happy path, relevant failure cases, and backward compatibility where applicable.

### Host-dependent ChurchTools data

When behaviour should be host-independent but ChurchTools uses numeric IDs internally,
prefer fixtures for at least two hosts with different IDs.

### Refactoring

Existing externally observable behaviour must remain unchanged. Add tests only where the
current suite does not adequately pin that behaviour.

Anything that changes diffing or planning must include a test that pins the rendered plan.

## 5. Never hide uncertainty with plausible defaults

Do not silently guess when data cannot be resolved.

Bad:

```text
status not found -> use ID 1
```

Good:

```text
status not found -> return a clear error with enough context to fix the configuration
```

Fallbacks are allowed only when they are part of the documented compatibility contract.

## 6. Treat destructive and security-sensitive changes as high risk

The following always require extra scrutiny:

- deletion or irreversible mutation of ChurchTools data,
- permission or rights changes,
- authentication, token, credential, or keychain handling,
- migrations or breaking configuration changes,
- changes that weaken dry-run, plan, or live-write safeguards.

Where technically meaningful, such changes should have:

- a dry-run or plan path,
- explicit error handling,
- regression tests,
- human approval before merge.

Never weaken existing safety gates merely to make tests or automation easier.

## 7. Review agents must challenge the implementation

A review pass should actively search for defects rather than merely confirm the author's
approach.

The reviewer should ask:

- Which assumptions were made?
- What regression could this introduce?
- Which edge cases are not covered by tests?
- Did the change touch more code than necessary?
- Is there a simpler implementation with the same contract?
- Are failures explicit, or are there silent fallbacks?
- Does the change remain portable across ChurchTools hosts?

When possible, implementation and review should be separate agent runs or contexts.

## 8. Risk classes

Use the highest applicable class.

### LOW

Examples:

- documentation-only changes,
- additional tests without production behaviour changes,
- internal renames with no observable behaviour change.

Expected verification: relevant tests and static checks pass.

### MEDIUM

Examples:

- normal features,
- bug fixes,
- parser, mapping, resolution, or adoption logic,
- changes to plan/apply behaviour that are not destructive.

Expected verification: focused tests, CI/static checks, and an independent review pass.

### HIGH

Examples:

- authentication or credentials,
- permissions,
- destructive writes,
- migrations,
- breaking changes,
- weakening of safety barriers.

Expected verification: focused tests, CI/static checks, independent review, and explicit
human approval before merge.

## 9. Completion report

For a non-trivial pull request, the agent should provide a short completion report with:

- what changed,
- the invariants that define correctness,
- which tests verify them,
- remaining known risks or gaps,
- what was deliberately left unchanged,
- the assigned risk class.

## 10. Repository checks

Use the repository's existing commands unless the change requires something more specific:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Do not run live writes unless the task explicitly requires live verification and the
existing live-write gates are satisfied.
