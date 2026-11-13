# Releasing

Two independently released artifacts: the **MCP server** and the **npm CLI**.
Both share ONE version, single-sourced in
[`archgen.config.json`](../archgen.config.json) at the repo root; the root
[`CHANGELOG.md`](../CHANGELOG.md) records every release.

| Artifact | Published as | Tag | Distribution |
|---|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-<version>` | npm |
| `packages/cli` | `archgen-skill` | `vcli-<version>` | npm |
| `skill/` | — | — | ships inside the CLI's vendor copy |

---

## The release checklist

**One command does the whole preparation.** A release touches a version in
several places and each one has a different owner, so remembering all of them
is how releases go half-done. `install.sh` carried the version as a
literal — the one real release surface a human still had to remember to
bump, twice — and the version gate carried a hand-written list of surfaces,
so a new one could be added without being checked.

```sh
npm run release:prepare <version>
```

It bumps the canonical version, propagates it to every derived surface,
regenerates both lockfiles, and then runs **every gate**. If any gate fails,
the release is not ready and the tool says so. It never publishes and never
tags — that stays a deliberate, human, one-tag-at-a-time action.

Add `--requires <version>` to raise the skill's capability declaration at the same
time. That declaration is a **human decision** — it says "this skill needs a
server that has these capabilities" — so the tool will not infer it; without
the flag it tells you the requirement still says the old thing.

Use `--dry-run` to see the plan without touching anything.

### What the command does, step by step

1. **The canonical version** — `archgen.config.json`. The version lives in
   exactly one place; every other file either derives it or is history.
2. **The capability contract** — `skill/SKILL.md`'s
   `metadata.requires.archgen_mcp`. Hand-edited on purpose.
3. **Every derived surface** — `npm run sync` rewrites the skill config, the
   frontmatter version, both `package.json` files and the vendored skill copy.
4. **Both lockfiles** — npm owns them; `npm install --package-lock-only`.
5. **Every gate** — versions, sync drift, the capability contract, the context
   budget, every suite, every fixture, and the immutable check.

Then: commit, tag, publish.

### The surfaces, and who owns each

| Surface | Owner |
|---|---|
| `archgen.config.json` | **you** — the canonical value |
| `skill/SKILL.md` → `metadata.requires.archgen_mcp` | **you** — a human decision |
| `skill/archgen.config.json`, `skill/SKILL.md` → `metadata.version` | `npm run sync` |
| `packages/*/package.json` | `npm run sync` |
| `packages/*/package-lock.json` | npm |
| `packages/cli/vendor/skills/archgen/` | `npm run sync` (build output) |
| `install.sh`'s managed-block stamp | **derived at runtime** from the shipped skill config |
| `scripts/smoke.sh`'s tarball names | **derived** from the canonical version |

Nothing else carries a version. `npm run test:versions` proves it: it
discovers the surfaces by rule (so a new package is covered the moment it
exists), checks every one against the canonical version, and fails if the
version is hardcoded anywhere else.

### Verify — zero drift, everything green

```sh
npm run sync:check
npm run test:versions
npm run test:contract
npm run test:budget
npm test
npm run test:fixtures
npm run test:immutable
bash scripts/smoke.sh
```

In order: the derived files and lockfiles match `archgen.config.json`; every
version surface agrees and the version lives in one place; the declared
minimum server version is satisfiable by this release; the always-on context
is within its ceiling; every suite CI runs passes; the four end-to-end drivers
pass against the real tools; the suites did not mutate the repository; and
the release itself — the packed tarballs, installed and driven — works.

`scripts/smoke.sh` is the one that answers "will this work for a user?". It
packs both npm tarballs — the exact bytes the registry would serve — installs
them into a clean project, and drives the real surfaces: the MCP server over
stdio, the tool catalog, the CLI installer, the harness wiring, the doctor,
the four end-to-end fixtures and the uninstall. It runs against an isolated
`HOME`, so it never touches your real harness configs.

`npm run test:versions` is the umbrella check. It runs two gates:

- **`version-consistency.mjs`** — every version surface must agree with
  `archgen.config.json`. The surfaces are DISCOVERED, not listed: every
  published manifest, every lockfile, the skill's derived copy and the
  vendored mirror. It also proves the version appears in exactly one place,
  and that `install.sh` carries no literal.
- **`version-lint.mjs`** — no `MAJOR.MINOR.x` version may be pinned in an
  *illustrative* surface: a doc, a README, a reference asset, a source
  comment. Examples show a shape, not a release — so no release ever has to
  go and update a comment by hand. The real surfaces keep concrete versions
  and are owned by the sync script and the capability-contract gate.

CI runs the same set: `vendor-check` (drift + version consistency),
`capability-contract`, `context-budget`, `structure`, `mcp`, `cli`, `coverage`,
`fixtures`, `immutable`, `audit` (high-severity advisories in both npm
packages) and `secret-scan`.

### Write the changelog

Add a `## [x.y.z] - YYYY-MM-DD` section to the root `CHANGELOG.md` (Keep a
Changelog format). State the **publish order** and the two tags.

### 1. Commit, tag, publish

```sh
git add -A && git commit -m "chore(release): x.y.z"
git tag -a vmcp-x.y.z      -m "archgen-mcp x.y.z — the MCP server that owns every archgen capability"
git push origin vmcp-x.y.z
git tag -a vcli-x.y.z      -m "archgen-skill x.y.z — the installer; wires the MCP server into every detected harness"
git push origin vcli-x.y.z
```

Push the tags in THIS order — one at a time, and check each run before the
next. The first push publishes `archgen-mcp`; the second publishes
`archgen-skill`.

**PUBLISH ORDER — the MCP server FIRST.** The CLI's installer resolves
`archgen-mcp` from the npm registry, so a release that advertises the MCP
server before it exists hands every user a broken bootstrap.

Pushing each tag triggers its automation:

| Tag | Workflow | What it does |
|---|---|---|
| `vmcp-x.y.z` | `publish-npm.yml` | tests, then `npm publish archgen-mcp` (with provenance) |
| `vcli-x.y.z` | `publish-npm.yml` | tests, then `npm publish archgen-skill` (with provenance) |

Each publish job first checks that the tag's version equals the package's
current version, so a tag left over from an older commit is refused rather
than publishing the wrong thing.

> **Push the tags one at a time and wait for each run.** If `vmcp-x.y.z`
> fails, `archgen-skill` would advertise a server that is not on the registry
> yet. After fixing the cause, you do NOT need to re-tag: open the failed
> run in GitHub Actions and click **Re-run failed jobs**.

### 2. npm credentials (one-time setup)

The publish job supports **two** authentication paths. npm tries OIDC first and
falls back to the token only if the OIDC exchange is refused — npm's OIDC
exchange never throws, it just leaves the existing credentials in place.

#### Path A — OIDC trusted publishing (recommended; no secret at all)

There is no long-lived credential in this repository to store, rotate, or leak.
The job proves it is the tagged commit from this repo, and npm grants a
short-lived token for exactly that one publish.

Configure it once per package on npmjs.com:

> Package → Settings → Trusted Publishers → GitHub Actions
>
> | field | value |
> |---|---|
> | organization/user | the npm account that owns the package |
> | repository | `akashmaurya99/archgen` |
> | workflow filename | `publish-npm.yml` |
> | environment | *(leave empty)* |

Requirements npm enforces: **npm CLI ≥ 11.5.1** and **Node ≥ 22.14.0**. The
publish job runs on Node 24 (which ships npm 11.x) and checks the npm version
before publishing, so the requirement is verified rather than assumed.

> **The chicken-and-egg with a brand-new package.** `archgen-mcp` did not
> exist on npm before this release, and a package that does not exist yet has
> no "Trusted Publishers" page to configure. So the FIRST publish of
> `archgen-mcp` must use Path B (a token). After it exists, configure Path A
> for it — and every later release needs no secret at all.

#### Path B — an npm automation token (the `NPM_TOKEN` secret)

Use this for the first publish of a new package, or as a permanent fallback.

1. Create a token: npmjs.com → the account menu → **Access Tokens** →
   **Generate New Token** → **Automation**. Scope it to the two packages
   (`archgen-mcp`, `archgen-skill`) and to **read and write** on the registry.
2. Store it in the repository:
   **GitHub → the repo → Settings → Secrets and variables → Actions → New
   repository secret**, name `NPM_TOKEN`, value = the token.
   (Use an *environment* secret instead if you prefer a manual approval gate.)

The workflow only puts the token in the environment when it exists — an empty
`NODE_AUTH_TOKEN` would make npm authenticate with `""` and fail with
`ENEEDAUTH` instead of using OIDC.

#### What happens if neither is configured

The publish job fails **before** the publish step, with an explicit message
naming both fixes. It never publishes something wrong, and it never fails
half-way.

The workflow runs `npm publish --provenance`, so the published tarball carries
an attestation linking it to this repository and commit.

---

## MCP server (`packages/mcp`)

The MCP server is the runtime that owns every deterministic capability. It is
published separately because the CLI stays zero-dependency while the server
depends on the official MCP SDK.

```sh
cd packages/mcp
npm ci
npm test
npm publish
```

The committed lockfile is the source of truth, the gates run first, and
`prepublishOnly` re-derives the version from `archgen.config.json`.

CI publishes this package automatically on the `vmcp-<version>` tag (see the
publish table above); the local command is the manual equivalent.

The published tarball contains only `bin/`, `src/`, `assets/`, `schemas/` and
`README.md` (see the `files` field). `assets/` carries the canonical registries
(`harness-mcp.json`, `skill-registry.json`, `depth-ladder.json`,
`platform-capabilities.json`), the dispatch briefs, the artifact templates AND
the protocol references — they ship WITH the server so a tool and its data can
never be a version apart.

## CLI (`packages/cli`)

`prepublishOnly` runs `scripts/sync-config.mjs` + `scripts/sync-vendor.mjs`,
which re-propagates the canonical config and syncs `skill/` into
`packages/cli/vendor/skills/archgen` before anything is published — never edit
files under `vendor/` directly; they are generated from the canonical skill.

```sh
cd packages/cli
npm test
npm publish
```

The gates run first, and `publish` syncs the config and the vendor mirror
automatically via `prepublishOnly`.

CI publishes this package automatically on the `vcli-<version>` tag.

The published tarball contains only `bin/`, `lib/`, `vendor/` and `README.md`
(see the `files` field).

## Skill

The skill is not published separately. It ships inside the CLI vendor copy and
is installed from this repo by `install.sh` / `archgen install`. Release it
implicitly with every CLI release.

It is **guidance only** — no code, no assets. Every deterministic capability
lives in the MCP server, which the skill's installer wires into each detected
harness.
