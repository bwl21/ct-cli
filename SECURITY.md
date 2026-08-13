# Security policy

## Reporting a vulnerability

Please report security issues through GitHub's
[private vulnerability reporting](https://github.com/eqrm/ct-cli/security/advisories/new)
rather than a public issue. Expect an initial response within a week.

## What this tool touches

`ct` authenticates to a ChurchTools instance with a **personal login token** that carries
your own permissions, and it performs writes (`ct apply`, `ct destroy`). When assessing
impact, the things worth knowing:

- **Tokens are never written to the repo.** They live in the OS keychain (`ct auth login`,
  keyed per host) or in `CT_LOGINTOKEN` for CI. `ct.envs.json` stores only the _name_ of a
  token env var, never a value, which is why it is safe to commit.
- **People are never managed.** Persons and memberships are out of scope by design and
  guarded in code — the tool manages the overarching, rights-bearing structure only.
- **Writes are opt-in and ordered.** `plan` is the default; `apply` needs explicit
  confirmation, protected environments additionally require the env name to be typed (or
  `--confirm-env`), and deletions never happen implicitly.
- **Grants are real permissions.** A config that declares permission grants can widen
  access on the target instance. Review a `plan` before applying it, the same way you
  would a Terraform plan.

## Scope

Vulnerabilities in this CLI are in scope. Vulnerabilities in ChurchTools itself are not —
report those to [ChurchTools](https://church.tools) directly.
