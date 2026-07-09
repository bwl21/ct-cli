# ct-cli

ChurchTools **structure-as-code** CLI. Describe the _overarching, rights-bearing
structure_ of a ChurchTools instance — campuses, structural groups, hierarchies,
group types/roles, permission & auto-groups — as versionable **desired-state
code**, and reconcile it idempotently against the ChurchTools API with
Terraform-style **`plan` / `apply`**.

> **People are never managed.** This tool touches only the scaffold, and only
> resources that are _explicitly_ declared or adopted. Everything else is
> invisible: never shown, never changed, never proposed for deletion.

## Two-repo model

| Repo                          | Contents                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| **`eqrm/ct-cli`** (this repo) | The tool: CLI, API client, plan/apply engine. Generic, reusable.                              |
| **`eqrm/ct-structure`**       | Equippers' actual desired-state config (`.ts` blueprints) + state file. Depends on this tool. |

Like Terraform, the tool never lives in the same repo as the infra config.

## Status

Early scaffold. See the [epic (#1)](https://github.com/eqrm/ct-cli/issues/1) and phase issues.

- ✅ **Phase 0 — Spike** ([#2](https://github.com/eqrm/ct-cli/issues/2)): API CRUD coverage mapped — see [`docs/api-coverage.md`](docs/api-coverage.md). Instance runs CT **3.123.0**; 7 resources have full CRUD.
- ✅ **Phase 1 — CLI + client** ([#3](https://github.com/eqrm/ct-cli/issues/3)): `auth login`, `get` commands, session handshake.
- ✅ **Phase 2 — Read/Adopt** ([#4](https://github.com/eqrm/ct-cli/issues/4)): `ct adopt` + JSON state file.
- ✅ **Phase 3 — Declarative engine** ([#5](https://github.com/eqrm/ct-cli/issues/5)): config DSL, `plan`/diff, dependency graph, group hierarchy.
- ✅ **Phase 4 — Apply + guardrails** ([#6](https://github.com/eqrm/ct-cli/issues/6)): `ct apply` / `ct destroy`, confirmation, backup, `preventDestroy`.
- ✅ **Phase 5 — Blueprints** ([#7](https://github.com/eqrm/ct-cli/issues/7)):
  all three planned features landed — auto-groups / dynamic groups
  ([#14](https://github.com/eqrm/ct-cli/issues/14)), permissions
  ([#13](https://github.com/eqrm/ct-cli/issues/13)), and blueprints
  ([#7](https://github.com/eqrm/ct-cli/issues/7)) — see
  [Auto-groups](#auto-groups), [Permissions](#permissions), and
  [Blueprints](#blueprints) below.
- 🚧 **Phase 6 — Reproducibility** ([#26](https://github.com/eqrm/ct-cli/issues/26)):
  what `ct` can't (yet) automate — API gaps, not-yet-implemented DSL surface,
  and deliberately out-of-scope areas — is tracked in
  [`docs/runbook-manual-surface.md`](docs/runbook-manual-surface.md), so instance
  bootstrap ([#23](https://github.com/eqrm/ct-cli/issues/23)) can scope
  "selective adoption" deliberately.

## Requirements

- Node ≥ 20 (repo pins 22 via `.nvmrc`)
- A ChurchTools **personal login token** (ChurchTools → your user settings)

## Install

Grab the latest tarball from the [Releases page](https://github.com/eqrm/ct-cli/releases/latest)
and install it globally with npm — no clone, no build step:

```bash
npm install -g https://github.com/eqrm/ct-cli/releases/latest/download/ct-cli-<version>.tgz
ct --help
```

(Replace `<version>` with the tag of the release you're installing, e.g. `v0.1.0`.)
Each release also attaches an `INSTALL.md` with the exact command for that tag.

Every push of a `v*` tag runs lint/typecheck/test/build and publishes the
resulting package as a GitHub Release ([`.github/workflows/release.yml`](.github/workflows/release.yml)).

## Install (dev)

```bash
npm ci
npm run build        # -> dist/index.js (the `ct` binary)
npm link             # optional: puts `ct` on your PATH
```

## Usage

```bash
# The host is captured at login (stored with the token). No hardcoded default —
# CT_HOST overrides the stored host for CI / one-off use.
ct auth login --host https://mychurch.church.tools --token <personal-login-token>
ct auth status                                  # who am I?

ct get campuses            # JSON to stdout — pipe into jq
ct get groups
ct get group-types
ct get raw /groups/42      # arbitrary GET

ct adopt campus 0          # bring an existing resource under management (→ state file)
ct state list              # show the managed set
ct plan                    # diff the desired-state config against ChurchTools (read-only)
ct plan --json             # the raw plan as JSON

ct apply                   # create + update in dependency order (confirmation + backup first)
ct apply --auto-approve    # skip the prompt (CI); apply NEVER deletes
ct destroy --target old    # explicit, protected deletion (typed confirmation)
```

`apply` reconciles **creates and updates** only, in dependency order, saving
state after each action (crash-safe / resumable). It **never deletes**: a
resource dropped from the config is surfaced as a notice pointing at `destroy`.
Before any write it prints the plan, asks for confirmation (`-y` to skip), and
writes a JSON backup of the affected resources to `backups/` beside the state
file (override with `--backup-dir` / `CT_BACKUP_DIR`).

`destroy` deletes only the resources named by `--target` (repeatable or
comma-separated), in reverse dependency order, after a typed confirmation
(`--force` to skip). A resource declared with `preventDestroy: true` is blocked
until that flag is removed from the config.

The desired state lives in a config file (default `ct.config.ts`) that
default-exports a function receiving the DSL:

```ts
export default (ct) => {
  ct.campus({ key: "mainz", name: "Mainz", shorty: "MZ" });
  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupTypeId: 2 });
  // Hierarchy is opt-in and multi-parent: `parents` are managed group keys, each declared
  // in this config. Omit it to leave a group's hierarchy unmanaged; edges to unmanaged
  // groups stay invisible. (`parent:` is unrelated — an ordering hint only, not hierarchy.)
  ct.group({ key: "mainz_kids_lead", name: "Mainz · Kids Leitung", groupTypeId: 2, parents: ["mainz_area"] });
};
```

Machine-readable output goes to **stdout** (pipe/`jq` it); human status lines go
to **stderr**.

### Blueprints

A "blueprint" is a plain function over the injected `ConfigContext` — no
special machinery. Pull a repeated structure (e.g. a campus's Kids area)
into a function and call it once per campus, prefixing every key with
`${campus}_` to keep each instantiation's resources unique and its managed
hierarchy (`parents`) scoped to that campus. `ct plan`/`ct apply` order
campuses → groups → hierarchy automatically via the dependency graph, and
an undeclared `parents` reference throws at config-load time (typo guard).
See [`docs/blueprints.md`](docs/blueprints.md) for the full guide and
[`examples/campus-blueprint.config.ts`](examples/campus-blueprint.config.ts)
for a runnable example.

### Auto-groups

A group can opt in to a `dynamic` block to manage its ChurchTools "dynamic
group" (auto-group) ruleset + status alongside its plain fields:

```ts
ct.group({
  key: "all_mainz",
  name: "Alle Mainz",
  groupTypeId: 1,
  dynamic: { status: "manual", ruleset: churchQueryRuleset /* inline object | { ref } | q + churchQuery */ },
});
```

`ct apply --refresh` opts in to a post-apply, per-group membership
recompute for every dynamic group that changed. See
[`docs/dynamic-groups.md`](docs/dynamic-groups.md) for the full guide (the
`status` states, the three ways to supply a ruleset, the typed query DSL,
and how drift normalization avoids cosmetic false diffs) and
[`examples/dynamic-group.config.ts`](examples/dynamic-group.config.ts) for a
runnable example.

### Permissions

`ct.groupRole` / `ct.groupTypeRole` declare ChurchTools permission grants
(group-role and group-type-role rights) as code, reconciled with the same
`plan`/`apply` workflow:

```ts
ct.groupTypeRole({
  key: "leiter_tpl",
  id: 1, // the domainId — the group type's own id for group_type_role
  grants: [
    "churchgroup:view",                                          // unscoped
    { right: "churchgroup:view group", scope: ["kids_area"] },   // scoped to a managed group
  ],
});
```

Right names (`"module:right"`) are validated against a static, offline
catalog — discover them with `ct get permissions-catalog`. Grants you remove
from the config are diffed as deletions and reconciled via `ct apply`, same
as any other resource; system-default and inherited grants are never touched
or surfaced. See [`docs/permissions.md`](docs/permissions.md) for the full
guide (domainId semantics, scope resolution, domain rules, the
baseline-tolerance model) and
[`examples/permissions.config.ts`](examples/permissions.config.ts) for a
runnable example.

## Auth model

The personal login token authenticates via a session handshake, **not** an
`Authorization` header:

1. `GET /api/whoami?login_token=<token>` → sets the session cookie
2. `GET /api/csrftoken` → CSRF token
3. every request sends the cookie; every write sends `CSRF-Token`

## Development

```bash
npm run dev -- get campuses   # run from source (tsx)
npm test                      # vitest
npm run typecheck
npm run lint
npm run format
npm run generate:client       # regenerate the typed client from the live OpenAPI spec
```

## Guardrails (by design)

- `plan` is the default; `apply` is explicit, with a confirmation prompt.
- `apply` never deletes; destruction is explicit via `destroy --target`.
- Destroy-protection (`preventDestroy` config flag); never implicit deletions.
- People/memberships are never touched (hard boundary in code).
- Backup/export before every `apply` and `destroy`.
- Rate-limit + retry on API calls (writes are never blindly re-sent on 5xx).
- Tokens live in the OS keychain / `.env`, never in git.
