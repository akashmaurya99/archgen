# Releasing

Three independently released artifacts: the **MCP server**, the **npm CLI**,
and the **VS Code extension**. All share ONE version, single-sourced in
[`archgen.config.json`](../archgen.config.json) at the repo root; the root
[`CHANGELOG.md`](../CHANGELOG.md) records every release.

| Artifact | Published as | Tag | Distribution |
|---|---|---|---|
| `packages/mcp` | `archgen-mcp` | `vmcp-<version>` | npm |
| `packages/cli` | `archgen-skill` | `vcli-<version>` | npm |
| `packages/extension` | ArchGen | `vextension-<version>` | GitHub Release (`.vsix`) |
| `skill/` | — | — | ships inside the CLI's vendor copy |

---

## The release checklist

Work top to bottom. Every step is verified by a CI gate, so a skipped step
fails the build rather than shipping.

### 1. Bump the canonical version

The version lives in exactly one place: the `version` field of
`archgen.config.json`.

```sh
# edit archgen.config.json → "version": "x.y.z"
```

### 2. Bump the capability contract (if the skill needs a newer server)

The skill declares the server version it requires:

```yaml
# skill/SKILL.md frontmatter
metadata:
  requires:
    archgen_mcp: ">=x.y.z"
```

**Raise it whenever the skill starts calling a tool or an action that only
exists in the new server** — a skill that silently calls a removed action fails
without an error. `metadata.requires` is NOT derived by the sync script; it is
edited by hand, on purpose: it is a human decision, not a derived fact.

`npm run test:contract` proves the declaration is satisfiable by this release.

### 3. Propagate to every derived target

```sh
npm run sync          # sync-config + sync-vendor
```

This regenerates `skill/archgen.config.json`, the `skill/SKILL.md` frontmatter
version, all three `package.json` files, and the vendored skill copy. Never
edit a derived file by hand.

Two derived locations live OUTSIDE the sync script:

- **`install.sh`** embeds the managed-block text as two heredocs, each carrying
  an `<!-- archgen:block vX.Y.Z -->` provenance line. Update **both** — they must
  stay byte-identical to `renderManagedBlockText()` / `renderClaudeBridgeText()`.
  The CLI suite's install.sh parity tests enforce this and fail the bump otherwise.
- **the two committed lockfiles** (`packages/mcp/package-lock.json`,
  `packages/extension/package-lock.json`) carry the package version in two
  places each. Regenerate them:

  ```sh
  npm --prefix packages/mcp install --package-lock-only --no-audit --no-fund
  npm --prefix packages/extension install --package-lock-only --no-audit --no-fund
  ```

### 4. Verify — zero drift, everything green

```sh
npm run sync:check     # derived files match archgen.config.json (writes nothing)
npm run test:contract  # the declared minimum is satisfiable by this release
npm run test:budget    # the always-on context is within its ceiling
npm test               # every suite CI runs
npm run test:fixtures  # the three end-to-end drivers, against the real tools
npm run test:immutable # the suites did not mutate the repository
```

CI runs the same set: `vendor-check` (drift), `capability-contract`,
`context-budget`, `mcp`, `cli`, `extension`, `fixtures`, `immutable`, `audit`
(high-severity advisories in both npm packages) and `secret-scan`.

### 5. Write the changelog

Add a `## [x.y.z] - YYYY-MM-DD` section to the root `CHANGELOG.md` (Keep a
Changelog format) and the matching one to `packages/extension/CHANGELOG.md`.
State the **publish order** and the three tags.

### 6. Commit, tag, publish

```sh
git commit -m "chore(release): x.y.z"

# in THIS order — one tag at a time, and check each run before the next
git tag -a vmcp-x.y.z      -m "archgen-mcp x.y.z — the MCP server that owns every archgen capability"
git push origin vmcp-x.y.z          # → npm publish archgen-mcp
git tag -a vcli-x.y.z      -m "archgen-skill x.y.z — the installer; wires the MCP server into every detected harness"
git push origin vcli-x.y.z          # → npm publish archgen-skill
git tag -a vextension-x.y.z -m "ArchGen extension x.y.z — the UI bridge and the MCP client"
git push origin vextension-x.y.z    # → GitHub Release with the .vsix
```

**PUBLISH ORDER — the MCP server FIRST.** The CLI's installer resolves
`archgen-mcp` from the npm registry, so a release that advertises the MCP
server before it exists hands every user a broken bootstrap. The extension is
version-agnostic and can ship in any order.

Pushing each tag triggers its automation:

| Tag | Workflow | What it does |
|---|---|---|
| `vmcp-x.y.z` | `publish-npm.yml` | tests, then `npm publish archgen-mcp` (with provenance) |
| `vcli-x.y.z` | `publish-npm.yml` | tests, then `npm publish archgen-skill` (with provenance) |
| `vextension-x.y.z` | `release.yml` | tests, builds the `.vsix`, publishes the GitHub Release |

Each publish job first checks that the tag's version equals the package's
current version, so a tag left over from an older commit is refused rather
than publishing the wrong thing.

> **Push the tags one at a time and wait for each run.** If `vmcp-x.y.z`
> fails, `archgen-skill` would advertise a server that is not on the registry
> yet. After fixing the cause, you do NOT need to re-tag: open the failed
> run in GitHub Actions and click **Re-run failed jobs**.

### 7. npm credentials (one-time setup)

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
npm ci                   # the committed lockfile is the source of truth
npm test                 # gates first
npm publish              # prepublishOnly re-derives the version from archgen.config.json
```

CI publishes this package automatically on the `vmcp-<version>` tag (see the
publish table above); the local command is the manual equivalent.

The published tarball contains only `bin/`, `src/`, `assets/` and `README.md`
(see the `files` field). `assets/` carries the canonical registries
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
npm test                 # gates first
npm publish              # syncs config + vendor automatically via prepublishOnly
```

CI publishes this package automatically on the `vcli-<version>` tag.

The published tarball contains only `bin/`, `lib/`, `vendor/` and `README.md`
(see the `files` field).

## Extension (`packages/extension`)

The `.vsix` is a build artifact — it is produced by CI (extension job:
`npm run package`, uploaded as the `archgen-extension-vsix` artifact) and is
NEVER committed to the repo (`*.vsix` is gitignored).

Local build (for smoke-testing a package):

```sh
cd packages/extension
npm ci
npm run typecheck && npm run compile && npm test
npm run package            # produces archgen-extension-<version>.vsix
```

Distribute via GitHub Releases: attach the CI-built `.vsix` for the
`vextension-<version>` tag to the release at
<https://github.com/akashmaurya99/archgen/releases> (download it from the
`archgen-extension-vsix` artifact of the tagged run), or install a locally
built one with `code --install-extension archgen-extension-<version>.vsix`.
Note: do not use `vsce package --no-dependencies` — it would drop the
externalized `better-sqlite3` native binding from the vsix.

## Skill

The skill is not published separately. It ships inside the CLI vendor copy and
is installed from this repo by `install.sh` / `archgen install`. Release it
implicitly with every CLI release.

It is **guidance only** — no code, no assets. Every deterministic capability
lives in the MCP server, which the skill's installer wires into each detected
harness.
