# UI as a Symmetric Core Projection — Implementation Plan

> **For agentic workers:** Implement this plan task by task. Do not start the Vue UI before the
> application operations in Tasks 1–4 exist and the CLI uses them. Each task must leave the existing
> CLI behavior and safety guarantees intact.

**Goal:** Add a local browser UI, launched by `ct server`, as a second, symmetric projection of the
same ct-cli core used by the command line. A capability is implemented once in the core and exposed
through thin CLI and HTTP/UI adapters; the UI must never become a second reconciliation engine.

**Architecture:** Preserve the existing domain modules (`engine`, `permissions`, `state`, `env`,
`auth`, `api`) and introduce an application layer that owns use-case orchestration. Commander and
Hono translate external input into the same typed operation requests. Terminal renderers and Vue
render the same typed results and progress events. Safety policy, confirmation requirements,
backups, state persistence, environment protection and mutation ordering remain below both
adapters.

**Tech Stack:** TypeScript, Commander, Hono, Vue 3, Vite, Vitest, Playwright, Bun standalone
executables. Keep the npm/Node >= 20 distribution working alongside the Bun binaries.

---

## Architectural invariants

These rules are acceptance criteria, not suggestions:

1. **One use case, one implementation.** `plan`, `apply`, `coverage`, `adopt`, `state rm`, `refresh`
   and `destroy` each have exactly one application operation.
2. **Both adapters call the same operation.** The server must not spawn `ct`, parse terminal output,
   or reconstruct CLI behavior. Commander must not call HTTP endpoints.
3. **The application core is presentation-free.** No Commander, Hono or Vue imports; no ANSI;
   no `process.stdout`, interactive prompt or `process.exitCode` access.
4. **Adapters do not access ChurchTools or state directly.** They translate input, invoke an
   operation and render/serialize its output.
5. **Guardrails live below the adapters.** A protected environment, incomplete plan,
   `preventDestroy`, backup requirement and confirmation type are decided and validated by the
   application/core, never by a button or Commander action alone.
6. **Results are structured.** Human-readable terminal output and visual UI are projections of
   typed result/error/event objects.
7. **Behavioral parity is tested.** Given the same project, environment and fake ChurchTools
   responses, CLI and HTTP must expose the same canonical operation result and side effects.
8. **People remain out of scope.** The UI must not introduce a path around the existing hard
   boundary.

Forbidden shortcuts:

```ts
// Never use the CLI as the server's application API.
spawn("ct", ["plan", "--json"]);

// Never let an HTTP route assemble a plan or mutate state itself.
app.post("/api/apply", async (c) => executePlan(/* route-owned orchestration */));
```

Target dependency direction:

```text
adapters/cli  ─┐
               ├──> application/operations ──> existing domain modules ──> infrastructure
adapters/http ─┘

web/Vue ──HTTP/SSE──> adapters/http
```

`application` may import the current `engine`, `permissions`, `state`, `env`, `auth`, `api`,
`config` and `resolve` modules. None of those modules may import an adapter.

---

## Shared contracts

Every operation exposes a typed request and a typed result. JSON transport types must not be a
second model: HTTP serializes these contracts or a deliberately small transport projection from
them.

Minimum common envelope:

```ts
export interface ProjectRequest {
  cwd?: string;
  configPath?: string;
  statePath?: string;
  environment?: string;
}

export interface OperationResult<T> {
  operation: OperationName;
  project: ResolvedProjectInfo;
  value: T;
  warnings: CtWarning[];
}

export type OperationEvent =
  | { type: "phase-started"; phase: string }
  | { type: "resource-reading"; resourceType: string; key: string }
  | { type: "resource-created"; resourceType: string; key: string; id: number }
  | { type: "resource-updated"; resourceType: string; key: string; id: number }
  | { type: "backup-written"; path: string }
  | { type: "warning"; warning: CtWarning };

export interface OperationObserver {
  emit(event: OperationEvent): void;
}
```

Errors use stable codes and structured details, for example `PLAN_INCOMPLETE`,
`AUTH_REQUIRED`, `HOST_MISMATCH`, `PROTECTED_ENV_CONFIRMATION_REQUIRED`,
`PLAN_CONFIRMATION_MISMATCH` and `PREVENT_DESTROY`. CLI maps them to messages/exit codes; HTTP maps
them to problem responses; Vue maps them to panels and field feedback.

### Prepared mutation model

Interactive mutations use the same two-stage contract in CLI and UI:

```text
prepareApply(request) -> PreparedApply { public result + opaque execution handle }
confirm in adapter
executePreparedApply(handle, confirmation proof) -> ApplyResult
```

The prepared object owns the exact plan, actual snapshot and required confirmation. The server
keeps it in a short-lived in-memory operation store and exposes only an unguessable operation ID.
The CLI keeps the same object in its process while prompting. The core validates the confirmation
proof and executes the prepared plan. This avoids both duplicate planning code and a UI-only
"apply whatever is current" path.

Prepared mutations expire, are single-use, and are invalidated when their relevant state file
changes. Only one mutation per state file may execute at a time.

---

## Task 1: Establish the application boundary and characterization tests

**Files:**

- Create: `src/application/contracts.ts`
- Create: `src/application/errors.ts`
- Create: `src/application/project.ts`
- Create: `src/application/ports.ts`
- Create: `tests/application/project.test.ts`
- Create: `tests/architecture-boundaries.test.ts`

- [x] Define `ProjectRequest`, `ResolvedProjectInfo`, operation result, warning, error and observer
      contracts. Keep values JSON-compatible where practical.
- [x] Extract shared project/environment resolution from the command wrappers into
      `resolveProject(request)`. It must retain current precedence for flags, environment profiles,
      `CT_CONFIG`, `CT_STATE`, host and token selection.
- [x] Define narrow ports for clock/ID generation, operation events and mutation locking. Do not
      wrap pure existing domain functions merely to rename them.
- [x] Add characterization tests for default config/state lookup, explicit paths, environment
      selection, protected environments and host-bound state.
- [x] Add an architecture test that scans imports and fails when `src/application/**` imports
      Commander, Hono or web code, or when adapter code imports mutation primitives such as
      `executePlan`, `saveState` or `applyPermissionPlan` directly.
- [x] Run `npm test`, `npm run typecheck` and `npm run lint`.

**Exit criterion:** There is one shared way to resolve the project context, but no CLI behavior has
changed yet.

---

## Task 2: Extract `plan` as the first shared operation

**Files:**

- Create: `src/application/operations/plan.ts`
- Create: `src/application/operations/index.ts`
- Modify: `src/commands/plan.ts`
- Modify: `src/engine/render.ts` only if needed to accept the shared result without recomputation
- Create: `tests/application/plan-operation.test.ts`
- Modify: existing plan command tests

- [x] Move all orchestration currently inside the Commander `.action()` into `runPlan(request,
dependencies?)`: environment preparation, config/catalog/state loading, session creation,
      shared resolver creation, concurrent resource/permission plan construction, completeness and
      summary calculation.
- [x] Return `PlanResult` containing resource plan, permission items, summary, attribution,
      warnings, fetch errors, environment/host/version metadata and `complete`.
- [x] Keep `renderPlan` and `renderPermissionPlan` as terminal renderers. They consume the operation
      result; they do not participate in planning.
- [x] Reduce `src/commands/plan.ts` to option parsing, operation invocation, rendering and exit-code
      mapping (`--detailed-exitcode` included).
- [x] Prove that the text and `--json` shapes remain compatible with existing tests.
- [x] Add a test that calls `runPlan` directly and the CLI adapter against the same fixtures and
      compares their canonical plan/summary.

**Exit criterion:** `ct plan` is only a projection of `runPlan`; a future HTTP handler can expose
the complete plan without importing an engine, resolver, state store or ChurchTools client.

---

## Task 3: Extract `apply` with shared confirmation and progress policy

**Files:**

- Create: `src/application/operations/apply.ts`
- Create: `src/application/prepared-operation-store.ts`
- Modify: `src/commands/apply.ts`
- Modify: engine/permission execution modules only to emit optional structured events
- Create: `tests/application/apply-operation.test.ts`
- Modify: existing apply and environment protection tests

- [x] Implement `prepareApply(request)` using the same plan-building primitives as `runPlan`.
      Factor a private/shared plan builder rather than copy the orchestration.
- [x] Return the rendered-independent proposal, exact prepared execution data, change count,
      warnings and a core-decided confirmation requirement (`yes` or exact environment name).
- [x] Implement `executePreparedApply(prepared, proof)` so the core validates completeness,
      confirmation, expiry, state-file identity and mutation lock before any write.
- [x] Keep backup-before-write, crash-safe state saves, dependency order, permission reconciliation
      and optional dynamic-group refresh in this operation.
- [x] Convert informational milestones to optional `OperationEvent`s. Terminal rendering must remain
      byte-compatible where covered by tests.
- [x] Reduce the Commander action to prepare, render, prompt, execute and map result/errors to exit
      status.
- [x] Test that CLI and direct operation calls produce identical writes, backup behavior and
      protected-environment refusal.
- [x] Test that an expired/reused prepared operation and a changed state file are refused.

**Exit criterion:** There is no safety decision or mutation orchestration unique to the CLI.

---

## Task 4: Extract all remaining operations before adding UI controls

**Files:**

- Create: `src/application/operations/coverage.ts`
- Create: `src/application/operations/adopt.ts`
- Create: `src/application/operations/state.ts`
- Create: `src/application/operations/refresh.ts`
- Create: `src/application/operations/destroy.ts`
- Create: `src/application/operations/auth.ts`
- Modify: corresponding files in `src/commands/`
- Create/modify: operation and CLI adapter tests

- [ ] Extract each command's orchestration into one operation with structured request/result/error
      contracts.
- [ ] Use the prepared mutation pattern for `destroy` and any adopt/state action requiring a prompt.
- [ ] Keep `preventDestroy`, typed target confirmation and protected-environment confirmation in the
      application operation.
- [ ] Keep auth tokens in the existing keychain/token store; return only non-secret auth status to
      adapters.
- [ ] Decide explicitly which `get` subcommands belong in the first UI. Expose selected reads through
      a shared query operation, not route-specific client calls.
- [ ] Add parity tests for every operation exposed in both adapters.

**Exit criterion:** The operation catalog is the authoritative product surface. A UI capability can
only be added by projecting an existing operation, or by first adding a core operation used by both
CLI and UI.

---

## Task 5: Add the local HTTP adapter and `ct server`

**Files:**

- Create: `src/server/app.ts`
- Create: `src/server/routes.ts`
- Create: `src/server/session.ts`
- Create: `src/server/operation-store.ts`
- Create: `src/server/static.ts`
- Create: `src/commands/server.ts`
- Modify: `src/index.ts`
- Create: `tests/server/*.test.ts`

**Command surface:**

```console
ct server
ct server --env dev
ct server --env prod --no-open
ct server --port 8765
ct server --config ./ct.config.ts --state ./ct.state.json
```

- [ ] Start on `127.0.0.1` only, using a free port by default. Do not add a public-listen mode in
      this milestone.
- [ ] Generate a high-entropy bootstrap secret, open the browser with the secret in the URL fragment,
      exchange it once for an `HttpOnly`, `SameSite=Strict` session cookie, then remove it from the
      browser URL.
- [ ] Enforce exact Origin checks, restrictive CORS behavior, CSP and no secret-bearing logs.
- [ ] Add thin endpoints whose handlers only validate transport input, call an application operation
      and serialize its result/error.
- [ ] Expose prepared mutations by opaque, expiring operation ID. Keep the prepared core object on
      the server; never serialize ChurchTools clients, tokens or mutable execution internals.
- [ ] Stream shared `OperationEvent`s via SSE. Do not create a separate web-only progress vocabulary.
- [ ] Serialize mutation execution per state file and return a structured busy response.
- [ ] Handle SIGINT/SIGTERM cleanly and print the local URL for `--no-open` use.
- [ ] Test session bootstrap, Origin/CSRF rejection, operation expiry, concurrent mutation rejection,
      no token exposure and graceful shutdown.

**Exit criterion:** The server is a transport adapter. Route tests can mock the operation catalog;
they never need to mock engine internals.

---

## Task 6: Build the Vue projection

**Files:**

- Create: `web/` Vue 3 + Vite application
- Create: `web/src/api/contracts.ts` or generate/re-export transport types from application contracts
- Create: views/components and frontend tests
- Modify: root build scripts and TypeScript configuration as needed

- [ ] Implement a typed API client and central operation/error/event handling. Do not reproduce
      plan summaries, confirmation policy or environment protection in the browser.
- [ ] Add the shared shell: current environment, host, ChurchTools version, auth status, config/state
      paths and connectivity.
- [ ] Add read-only projections first: dashboard, plan, hierarchy/resources, permissions, coverage,
      state and run progress.
- [ ] Render field attribution (`config`, `drift`, `config+drift`), unreadable resources and incomplete
      plans from core fields rather than recalculating them.
- [ ] Add Apply only after the read-only views are stable. Display the core-provided confirmation
      requirement and submit the proof with the prepared operation ID.
- [ ] Add adopt, state removal, refresh and destroy by projecting their shared operation contracts.
- [ ] Keep config read-only in the first milestone. A future editor may validate/save source, but it
      must not introduce a form-to-TypeScript reconciliation engine.
- [ ] Add component tests plus Playwright flows using a fake application-operation backend.

**Exit criterion:** Removing Vue leaves every ct capability available through the CLI, and removing
Commander leaves the same operations available to the server. Neither removal affects domain logic.

---

## Task 7: Embed assets and ship macOS/Windows binaries

**Files:**

- Modify: `package.json`
- Modify: `tsup.config.ts`
- Modify: `.github/workflows/release.yml`
- Modify/Create: binary smoke-test scripts
- Modify: npm package `files` list/build output

- [ ] Build the Vue assets once and make the same bytes available to both distributions: embedded
      in Bun standalone executables and packaged under `dist/web` for npm/Node users.
- [ ] Keep `ct` and `ct server` in one executable; do not introduce a separately versioned UI
      product.
- [ ] Add `bun-windows-x64-baseline` (or document a tested reason for the non-baseline target) and
      retain Darwin arm64/x64. Add Windows arm64 only after native CI coverage exists.
- [ ] Native-smoke-test macOS and Windows artifacts: `ct --help`, server startup with `--no-open`,
      `/api/health`, Vue asset delivery, fixture config load and clean shutdown.
- [ ] Smoke-test the npm tarball under Node >= 20 as well; Bun-only server APIs must not leak into the
      npm execution path.
- [ ] Add release asset names and installation instructions for Windows.

**Exit criterion:** A user downloads one `ct` binary and receives the same CLI and UI/core behavior
on macOS and Windows.

---

## Task 8: Documentation and enforcement

**Files:**

- Create: `docs/ui.md`
- Create: `docs/architecture.md` or extend an existing architecture document
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] Document `ct server`, local-only security, lifecycle, supported platforms and troubleshooting.
- [ ] Document the dependency rule and the required sequence for new features: operation contract,
      core implementation/tests, CLI projection, HTTP/UI projection.
- [ ] Add a contributor checklist: no adapter-direct state/API access, no shelling out, no duplicated
      summaries/policy, parity test added.
- [ ] Document deliberate projection differences: terminal vs visual rendering and prompt vs dialog
      are allowed; business meaning, defaults, guardrails and side effects are not.
- [ ] Run the complete CI gate and both browser/binary smoke suites.

---

## UI surface for the first release

The first release projects existing capabilities; it does not broaden ct-cli's management scope.

| Core operation | CLI projection        | UI projection                                |
| -------------- | --------------------- | -------------------------------------------- |
| plan           | `ct plan`             | Plan page and “Plan erstellen”               |
| apply          | `ct apply`            | prepared plan, confirmation dialog, progress |
| coverage       | `ct coverage`         | coverage summary and searchable tables       |
| state list/rm  | `ct state ...`        | state page and guarded removal               |
| adopt          | `ct adopt ...`        | resource detail action                       |
| refresh        | `ct refresh`          | dynamic-group action                         |
| destroy        | `ct destroy --target` | isolated danger-zone flow                    |
| auth status    | `ct auth status`      | non-secret header/status panel               |

Allowed presentation-specific behavior:

- CLI renders text/ANSI; Vue renders tables, badges, trees and dialogs.
- CLI prompts on stdin; Vue collects the same required proof in a dialog.
- CLI streams lines; Vue consumes the same events over SSE.

Not allowed:

- UI-only plan filters that change plan semantics.
- UI-only apply defaults or weaker confirmations.
- Recomputed summary/drift/coverage logic in JavaScript components.
- Direct ChurchTools requests from the browser.
- Browser storage of ChurchTools tokens.

---

## Verification matrix

For each operation exposed through both projections, test the following fixture scenarios:

| Scenario             | Core                     | CLI adapter                         | HTTP adapter          | Vue            |
| -------------------- | ------------------------ | ----------------------------------- | --------------------- | -------------- |
| success/no changes   | canonical result         | text + exit code                    | JSON status           | empty state    |
| changes pending      | exact items/summary      | text/JSON + exit 2 where applicable | same data             | diff view      |
| drift                | attribution              | drift text                          | same attribution      | drift badge    |
| partial fetch        | `complete=false`         | exit 1                              | problem/result status | Apply disabled |
| protected env        | confirmation requirement | typed prompt                        | same requirement      | typed dialog   |
| host mismatch        | stable error             | message + exit 1                    | problem response      | error panel    |
| interrupted mutation | persisted progress       | resumable message                   | resumable result      | run status     |

The canonical assertions belong to operation tests. Adapter tests assert translation only; they must
not duplicate all reconciliation cases already proven below the boundary.

---

## Definition of done

- `ct plan` and the UI plan are projections of the same `runPlan` result.
- `ct apply` and UI Apply execute the same prepared operation and core-owned confirmation policy.
- No server route imports ChurchTools clients, plan executors, permission writers or state writers.
- No application operation imports Commander, Hono, Vue or presentation helpers.
- CLI compatibility tests remain green.
- Parity tests cover all operations available in both adapters.
- Tokens never reach frontend state, browser storage, URLs sent to the server or logs.
- The server binds locally by default and rejects cross-origin mutation attempts.
- macOS and Windows standalone binaries, plus the npm/Node distribution, pass native smoke tests.
- The UI adds no person or membership management and no implicit deletion path.
