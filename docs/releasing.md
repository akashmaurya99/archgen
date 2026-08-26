# Releasing

Two independently released artifacts: the npm CLI and the VS Code extension.
Both share ONE version, single-sourced in [`archgen.config.json`](../archgen.config.json)
at the repo root; the root [`CHANGELOG.md`](../CHANGELOG.md) records every release.

## Version bumps (single source)

The version lives in exactly one place: the `version` field of
`archgen.config.json`. Every derived location — `skill/archgen.config.json`,
the `skill/SKILL.md` frontmatter, `packages/cli/package.json`,
`packages/extension/package.json`, and the vendored skill copy — is generated
from it. Never edit a derived file by hand; run the sync instead:

```sh
# 1. Bump the canonical version
#    edit archgen.config.json → "version": "x.y.z"

# 2. Propagate to every derived target (config + SKILL.md + both package.json),
#    then mirror skill/ into packages/cli/vendor/skills/archgen
node packages/cli/scripts/sync-config.mjs && node packages/cli/scripts/sync-vendor.mjs
#    (equivalent npm script: npm --prefix packages/cli run sync)

# 3. Verify zero drift (writes nothing; exits 1 and lists drift if any)
npm --prefix packages/cli run sync:check
```

`sync-vendor` is idempotent and leaves already-correct files byte-identical.
CI's `vendor-check` job runs `sync:check` plus a `sync` + `git diff --exit-code`
gate, so a release committed without the sync step fails the build.

One more derived location lives outside the sync script: `install.sh` embeds
the managed-block text as two heredocs, each carrying an
`<!-- archgen:block vX.Y.Z -->` provenance line. Update both lines to the new
version — they must stay byte-identical to `renderManagedBlockText()` /
`renderClaudeBridgeText()` (the CLI suite's install.sh parity tests enforce
this and fail the bump otherwise).

Then record and tag the release:

1. Add a section to the root `CHANGELOG.md` under a `## [x.y.z] - YYYY-MM-DD`
   heading (Keep a Changelog format).
2. Tag the release `v<pkg>-<version>` — e.g. `vcli-0.0.5`, `vextension-0.0.5` —
   so both packages can tag independently on one repo even though they share
   the same version number.

```sh
git commit -m "chore(release): 0.0.5"
git tag vcli-0.0.5
git tag vextension-0.0.5
git push && git push --tags
```

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

The published tarball contains only `bin/`, `lib/`, `vendor/`, and `README.md`
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
