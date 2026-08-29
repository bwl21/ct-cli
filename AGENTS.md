# AGENTS.md

AI coding agents working in this repository must follow:

- [`CONTRIBUTING.md`](CONTRIBUTING.md) for repository workflow and core invariants,
- [`SECURITY.md`](SECURITY.md) for credential and security requirements,
- [`docs/agent-safety.md`](docs/agent-safety.md) for agent-specific safety, verification,
  review, and risk-classification rules.

Before implementing a non-trivial change, state the intended behavioural contract,
compatibility requirements, risks, and verification plan.

Keep changes narrowly scoped. Do not perform unrelated refactors, public API changes,
dependency swaps, configuration format changes, or compatibility removals unless they are
part of the task.

Use the repository's normal verification commands as applicable:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

For behavioural changes, add focused automated tests. For host-independent behaviour that
maps ChurchTools numeric IDs, prefer cross-host fixtures with different IDs.

Never weaken plan/dry-run/live-write safeguards to simplify an implementation or test.
Never guess unresolved domain mappings with plausible defaults.

For non-trivial PRs, report the invariants verified, tests run, remaining risks, deliberately
unchanged scope, and risk class (LOW, MEDIUM, or HIGH) as defined in
`docs/agent-safety.md`.
