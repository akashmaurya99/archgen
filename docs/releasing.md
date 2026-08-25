# Releasing

Two independently released artifacts: the npm CLI and the VS Code extension. Versions are tracked in each package's `package.json` and in the root [`CHANGELOG.md`](../CHANGELOG.md).

## Version bumps

Manual, Changesets-style:

1. Edit the package's `version` field (`packages/cli/package.json` and/or `packages/extension/package.json`).
2. Add a section to the root `CHANGELOG.md` under a `## [x.y.z] - YYYY-MM-DD` heading (Keep a Changelog format).
3. Tag the release `v<pkg>-<version>` — e.g. `vcli-1.0.1`, `vextension-0.2.0` — so both packages can version independently on one repo.

```sh
git commit -m "chore(release): cli 1.0.1"
git tag vcli-1.0.1
git push && git push --tags
```

## CLI (`packages/cli`)

`prepublishOnly` runs `scripts/sync-vendor.mjs`, which syncs `skill/` into `packages/cli/vendor/skills/archgen` before anything is published — never edit files under `vendor/` directly; they are generated from the canonical skill.

```sh
cd packages/cli
npm test                 # gates first
npm publish              # syncs vendor automatically via prepublishOnly
```

The published tarball contains only `bin/`, `lib/`, `vendor/`, and `README.md` (see the `files` field).

## Extension (`packages/extension`)

```sh
cd packages/extension
npm ci
npm run typecheck && npm run compile && npm test
npx @vscode/vsce package   # produces archgen-extension-<version>.vsix
```

Distribute the `.vsix` via GitHub Releases for the `vextension-<version>` tag (or `code --install-extension archgen-extension-<version>.vsix` locally). Note: do not use `vsce package --no-dependencies` — it would drop the externalized `better-sqlite3` native binding from the vsix.

## Skill

The skill is not published separately. It ships inside the CLI vendor copy and is installed from this repo by `install.sh` / `archgen install`. Release it implicitly with every CLI release.
