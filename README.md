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
- 📖 **Field definitions & security levels** ([#47](https://github.com/eqrm/ct-cli/issues/47),
  [#48](https://github.com/eqrm/ct-cli/issues/48)): the person master-data model,
  security levels, and person/group custom-field DEFINITIONS ("Datenfelder") are
  readable (`ct get person-masterdata`, `ct get data-fields`) — schema in scope,
  per-record field **values** never. Definitions are read-only (no REST write
  endpoint); the boundary + writability evidence is in
  [`docs/field-definitions.md`](docs/field-definitions.md).

## Requirements

- Node ≥ 20 (repo pins 22 via `.nvmrc`) — only for the npm tarball or dev install;
  the standalone binaries below need nothing but the OS
- A ChurchTools **personal login token** (ChurchTools → your user settings)

## Install

Grab the standalone binary from the [Releases page](https://github.com/eqrm/ct-cli/releases/latest) —
**no Node required**:

```bash
# macOS, Apple Silicon
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-darwin-arm64
# macOS, Intel
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-darwin-x64
# Linux, x64
curl -L -o ct https://github.com/eqrm/ct-cli/releases/latest/download/ct-linux-x64

chmod +x ct
sudo mv ct /usr/local/bin/ct   # or anywhere on your PATH
ct --help
```

Or, with Node ≥ 20 already installed, the npm-pack tarball:

```bash
npm install -g https://github.com/eqrm/ct-cli/releases/latest/download/ct-cli.tgz
ct --help
```

Each release also attaches an `INSTALL.md` with the exact commands.

Every push to `main` that lands a `feat:`/`fix:`/breaking-change commit runs the
full CI gate, compiles the binaries above, smoke-tests each one on its native
OS/arch, and — only if all of that is green — cuts the version + changelog via
[semantic-release](https://semantic-release.gitbook.io/) and publishes the GitHub
Release. No manual tag push. See
[`.github/workflows/release.yml`](.github/workflows/release.yml) and
[`.releaserc.json`](.releaserc.json).

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
ct get person-masterdata   # person master-data model incl. security levels (schema, read-only)
ct get data-fields         # field DEFINITIONS: person + group custom fields (schema, read-only)
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
  // Reference master data BY NAME, not by hardcoded id: `groupType: "…"` resolves to the
  // per-host group-type id at plan time, so this config is portable across instances (#20).
  ct.group({ key: "mainz_area", name: "Mainz · Bereiche", groupType: "ministry_team" });
  // Hierarchy is opt-in and multi-parent: `parents` are managed group keys, each declared
  // in this config. Omit it to leave a group's hierarchy unmanaged; edges to unmanaged
  // groups stay invisible. (`parent:` is unrelated — an ordering hint only, not hierarchy.)
  ct.group({ key: "mainz_kids_lead", name: "Mainz · Kids Leitung", groupType: "ministry_team", parents: ["mainz_area"] });
  // Assign a group to a campus BY KEY: `campus: "mainz"` links to the campus above even though
  // it is created in the same apply (its id is filled in at apply time). The numeric escape
  // hatch still works — `campusId: 3` (or `campusId: null` to clear) targets an existing id.
  ct.group({ key: "mainz_kids", name: "Mainz · Kids", groupType: "ministry_team", campus: "mainz", parents: ["mainz_kids_lead"] });
};
```

**Portable references (#20):** logical fields (`campus`/`groupType` on a
group, `groupType` on a permission) and the inline `ref.*` helper compile to id-free
sentinels a per-host resolver maps to real ChurchTools ids at plan time — sourced from
resources this tool manages, then live master-data catalogs matched by name. So one
config file plans and applies unchanged against different instances (ids differ per
host). An unresolvable name fails the plan with a clear error naming the reference and
where it was used. Raw numeric ids remain a valid escape hatch everywhere; see
[`examples/portable.config.ts`](examples/portable.config.ts) for a zero-numeric-id config.
**Exception: `groupStatusId` (a group's lifecycle status) is numeric-only, always** —
ChurchTools exposes no REST catalog to resolve a status by name (`/group/memberstatus`
is a different dimension, member statuses; #67), so a `status:` declaration fails fast
at eval time rather than resolving against the wrong dimension.

`campusId` is a managed group field: `ct plan` shows a campus assign/move/clear
as a normal field update, and `ct adopt group <id>` captures it. Which group
fields are managed vs. deliberately left to the CT UI is recorded in
[`docs/group-field-decisions.md`](docs/group-field-decisions.md).

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
  groupType: "kids", // domain BY NAME — resolved to the group-type domainId per host (#20)
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

## Environments (dev → prod promotion)

One config repo can drive several ChurchTools instances — e.g. an `eqrm-dev`
rehearsal env and the real `prod` — Terraform-workspace-style, with **no file
edits** when switching. Declare the environments once in a committed
`ct.envs.json` in the config repo (default path; override with `CT_ENVS`):

```json
{
  "environments": {
    "dev": { "host": "https://eqrm-dev.church.tools" },
    "prod": {
      "host": "https://eqrm.church.tools",
      "state": "ct-state.prod.json",
      "protected": true,
      "tokenEnv": "CT_PROD_TOKEN"
    }
  }
}
```

Each profile is a `(host, state file, token reference)` triple:

- **`host`** — the instance this env targets (the source of truth for `--env`;
  it overrides any ambient `CT_HOST`).
- **`state`** — the committed state file. Defaults to the `ct-state.<env>.json`
  convention (`ct-state.dev.json`, `ct-state.prod.json`), overridable per env.
  Both files live in the config repo and are committed, so `dev` and `prod`
  never share a state file.
- **`tokenEnv`** — the **name** of an environment variable holding the login
  token (for CI); never a literal secret, so the file is safe to commit.
- **`protected`** — see the guardrail below.

Every state/host-touching command takes `--env <name>` (`-e`):

```bash
ct plan  --env dev     # diff dev's config against the dev host, using ct-state.dev.json
ct apply --env dev
ct plan  --env prod    # SAME checkout, no edits — prod host + ct-state.prod.json
ct state list --env prod
ct get groups --env dev
```

Without `--env`, behaviour is unchanged (single stored login, `ct-state.json`).

**Token resolution** for a chosen env: `CT_LOGINTOKEN` env (CI — a profile
`tokenEnv` is copied here when set) → the host-keyed Keychain entry. `ct auth
login` now stores credentials **per host**, so one machine can hold logins for
`dev` and `prod` at once (a pre-existing single login still works as a fallback).

**Cross-contamination is impossible:** every state file is bound to its host, and
loading a state file against a different host is refused —
`State file host (…) does not match … Refusing to mix instances.` — so `--env prod`
can never read or write a dev-bound state file.

**Version gate per env:** envs may run different ChurchTools versions.
`ct plan --env <name>` surfaces the target env's name **and** its live CT version
in the header (e.g. `env: prod · host: … · ChurchTools 3.123.0 · …`), so a
dev/prod version skew is visible before you promote.

### Protected environments

Mark an env `"protected": true` and **apply/destroy against it ALWAYS require
typed confirmation of the environment name — even with `--auto-approve` (apply)
or `--force` (destroy)**. For non-interactive/CI use, pass `--confirm-env <name>`,
which must match the target env name exactly and substitutes for the typed input:

```bash
ct apply --env prod                          # prompts: type "prod" to confirm
ct apply --env prod --auto-approve           # STILL prompts — auto-approve does not bypass a protected env
ct apply --env prod --auto-approve --confirm-env prod   # CI: applies (flag matches)
ct destroy --env prod --target old --confirm-env prod   # --force alone is NOT enough on a protected env
```

### Promotion workflow

Promote a change dev → prod, verifying against the rehearsal env before the real one:

```bash
# 1. Plan + apply against dev (rehearsal)
ct plan  --env dev
ct apply --env dev

# 2. Verify the change on dev: re-plan should be a clean no-op (round-trip),
#    optionally recomputing dynamic-group membership.
ct plan  --env dev            # expect "No changes"
ct apply --env dev --refresh  # (only if the change touched dynamic groups)

# 3. Plan against prod — inspect the header's CT version and the diff carefully.
ct plan  --env prod

# 4. Apply to prod. Protected → confirm the env name (or --confirm-env prod in CI).
ct apply --env prod
```

Commit both state files (`ct-state.dev.json`, `ct-state.prod.json`) after each
apply — they are the record of what is managed on each instance.

## CI usage

`ct` runs non-interactively out of the box — every state/host-touching command
works from a CI runner with no OS keychain.

### Authentication

Skip the keychain with two env vars (see `src/auth/tokenStore.ts`):

```bash
export CT_HOST=https://eqrm.church.tools
export CT_LOGINTOKEN=<personal login token — from a CI secret>
ct plan
```

`CT_LOGINTOKEN` always wins over stored credentials, so this works even on a
machine that also has an interactive login. Under `--env`, a profile's
`tokenEnv` (in `ct.envs.json`) names the secret env var to read for that
target — see [Environments](#environments-dev--prod-promotion) — and a
protected env's apply/destroy still needs `--confirm-env <name>` (below);
`CT_LOGINTOKEN`/`CT_HOST` alone do not bypass that guardrail.

### Detecting whether there are changes: `--detailed-exitcode`

Terraform-style. With the flag, `ct plan` exits:

| Exit code | Meaning |
|---|---|
| `0` | no changes — desired state already matches ChurchTools (resources AND permissions) |
| `1` | error — the plan is INCOMPLETE (a resource or permission fetch failed), or the command failed outright |
| `2` | changes are pending — at least one resource item is not a no-op, OR at least one permission item has a grant/revoke to apply |

Without the flag, behaviour is byte-identical to before: `ct plan` exits `1`
only on an INCOMPLETE plan/error, `0` otherwise — so existing scripts that just
check for a nonzero exit code keep working unchanged.

```bash
ct plan --detailed-exitcode --env prod
case $? in
  0) echo "no changes" ;;
  1) echo "plan failed"; exit 1 ;;
  2) echo "changes pending — needs review/apply" ;;
esac
```

**Drift alone never sets exit `2`.** `--detailed-exitcode` mirrors what `ct
apply` would actually *do* — an item can carry drift (ChurchTools changed
since the last apply) while its `action` stays `no-op` (the drifted field
isn't managed by the current config, or happens to already match it), and
`apply` would write nothing for it. Drift is always visible in the human
render's "Drift detected" section and in `--json`'s per-item `drift` array
regardless of the exit code — see below.

An INCOMPLETE plan is always exit `1`, even with `--detailed-exitcode` and
even if the (partial) plan has changes: an incomplete diff can't be trusted
enough to report "changes pending" instead of "this run failed".

### Machine-readable output: `--json`

`ct plan --json` prints **only** the plan JSON to stdout — the env/host
header and any `INCOMPLETE`/permission-catalog warnings go to stderr, so
piping/`jq`-ing stdout is always safe. It composes with `--detailed-exitcode`:
the exit code is derived from the exact same data that lands on stdout.

Shape:

```jsonc
{
  "plan": {
    "items": [
      {
        "type": "group", "key": "kids", "id": 7, "action": "update",
        "changes": [
          { "field": "name", "from": "Kid's", "to": "Kids", "source": "config" }
        ],
        "drift": [
          { "field": "campusId", "from": 4, "to": 9 }
        ]
      }
    ]
  },
  "permissions": [ /* PermissionPlanItem[]: { key, domainType, domainId, pendingDomain?, diff: { toPut, toDelete, preserved } } */ ],
  "summary": {
    "resources": { "create": 0, "update": 1, "delete": 0, "no-op": 3 },
    "drifted": 1,
    "permissions": { "toPut": 0, "toDelete": 0, "preserved": 0 },
    "hasChanges": true
  }
}
```

**Distinguishing drift from a config change**, per resource item:

- `changes` is what `ct apply` would actually write: desired config vs. the
  live ChurchTools value, field by field. Every `changes` entry on a create
  is necessarily `"source": "config"` (there is no live baseline yet to
  drift from). On an update, each entry carries a best-effort `source`,
  attributed from the same three values the engine already has — the
  last-known state snapshot, the desired config, and the fetched actual:
  - `"config"` — ChurchTools still matches the last-known snapshot; the
    diff exists purely because the desired config changed since the last
    apply.
  - `"drift"` — the config is unchanged, but ChurchTools was edited
    manually since the last apply; applying reverts that manual edit.
  - `"config+drift"` — both moved independently (config changed AND
    ChurchTools drifted) to values that don't coincide.
- `drift` (top-level, on the item) is informational and present whenever
  non-empty: every field where ChurchTools has moved away from the
  last-known state snapshot, regardless of whether the current config even
  manages that field — a **superset** of what `changes[].source` narrows
  down to only the fields `apply` will actually touch.
- **Permission items carry no `source`.** The state file snapshots managed
  *resource* fields only, not granted permissions, so there is no
  last-known baseline to attribute a permission diff to config-vs-drift.
  `diff.toPut`/`diff.toDelete` is honestly just desired-vs-actual — this is
  the one place the tool cannot make the distinction, so it doesn't
  pretend to.
- **A permission domain declared by reference to a same-run-created group
  type** (e.g. `ct.groupTypeRole({ groupType: "struktur", ... })` against a
  fresh instance where `struktur` is itself in the create-set) plans as a
  **pending domain** instead of aborting. Its `domainId` is `null` and it
  carries a `pendingDomain` object (the logical reference, e.g.
  `{ kind: "group-type", key: "struktur", __ctRef: true }`); the human render
  shows `<group-type:struktur (created this apply)>`. Its grants land in
  `diff.toPut` and count toward `summary.permissions.toPut`, `hasChanges`,
  and exit code `2` — so a fresh-instance `ct plan` reports the create-set +
  pending grants rather than failing. `ct apply` re-resolves the real domain
  id after the group type is created and reconciles the grants in the same
  run. The hard error is reserved for references that resolve to nothing at
  all (a key absent from the config, state, and the live catalog — a typo).

### Posting a plan as a PR comment

The human renderer (`renderPlan` / `renderPermissionPlan`) is safe to paste
into a GitHub PR comment: it uses `picocolors`, which disables ANSI color
whenever stdout isn't a TTY or `NO_COLOR` is set, and the `+`/`~`/`-`/`!`/`?`
line prefixes already carry the create/update/delete/drift/unresolved meaning
— the rendering reads cleanly with no color at all.

**One GitHub Actions gotcha:** picocolors treats the `CI=true` env var (set by
every GitHub Actions runner) as its own signal to force color ON, even when
stdout is redirected to a file — so `ct plan > plan.txt` on a runner still
embeds ANSI escapes unless you override it. Set `NO_COLOR=1` when capturing
output for a PR comment:

```yaml
- name: Plan
  id: plan
  env:
    CT_HOST: ${{ vars.CT_HOST }}
    CT_LOGINTOKEN: ${{ secrets.CT_LOGINTOKEN }}
    NO_COLOR: "1"
  run: |
    set +e
    ct plan --detailed-exitcode > plan.txt
    echo "exitcode=$?" >> "$GITHUB_OUTPUT"
    set -e

- name: Comment plan on PR
  if: always()
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const body = fs.readFileSync('plan.txt', 'utf8');
      const exitcode = '${{ steps.plan.outputs.exitcode }}';
      const verdict = exitcode === '0' ? 'No changes' : exitcode === '2' ? 'Changes pending' : 'Plan FAILED';
      await github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: `### ct plan — ${verdict}\n<details><summary>Show plan</summary>\n\n\`\`\`\n${body}\n\`\`\`\n</details>`,
      });
```

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
- Protected environments (`"protected": true`): apply/destroy always require typed
  confirmation of the env name — `--auto-approve`/`--force` never bypass it.
- Per-env state files are host-bound: `--env prod` can never touch a dev-bound state.
- People/memberships are never touched (hard boundary in code).
- Backup/export before every `apply` and `destroy`.
- Rate-limit + retry on API calls (writes are never blindly re-sent on 5xx).
- Tokens live in the OS keychain / `.env`, never in git.
