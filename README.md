# TritonAI Installer

Public source for the cross-platform TritonAI installer. The packaged desktop app is currently named **UCSD AI Tools Installer** and installs the branded **TritonAI Harness** desktop build, configures Codex as the managed backend, and routes model access through UCSD/TritonAI without requiring users to hand-edit dotfiles or bring their own Node.js installation.

The repo is intentionally broader than the current Harness-only flow. It can remain the home for future TritonAI-managed desktop setup, repair, and packaging work even if the installed tools expand beyond TritonAI Harness.

The installer is an Electron app with a config-driven install layer. TritonAI Harness/Codex setup lives in `src/installer/runner.js`, `src/installer/tool-manifest.js`, and `src/installer/config-writers.js`.

## Public Repository Status

This repository is designed to be created from a clean working tree, not migrated with private history. The public tree does not include packaged `vendor/` payloads, generated build artifacts, local automation scripts, deployment config, API keys, signing material, or release credentials.

Repo-local GitHub automation included here:

- `.github/workflows/installer-tests.yml` runs macOS and Windows clean-install tests on pull requests and pushes to `main`.
- `.github/workflows/issue-labels.yml` syncs managed issue labels.
- `.github/ISSUE_TEMPLATE/` contains bug and feature intake templates.

GitHub App integrations such as CodeRabbit and Greptile are configured outside the tracked source tree. Enable those apps on the new GitHub repository after it is created; see `docs/repository-setup.md`.

## What It Does

1. Prompts for a UCSD/TritonAI API key, prefilling an existing `TRITONAI_API_KEY` when one is already configured, with an option to open key documentation.
2. Provisions a private user-scoped Node.js/npm runtime when needed.
3. Copies and verifies a pinned managed Codex CLI from the installer payload under `~/.agents/ucsd/runtime/codex/openai-codex-0.141.0/`.
4. Points TritonAI Harness at that installer-owned Codex binary and `~/.tritonai-harness/codex` home so system/global installs cannot drift the runtime.
5. Writes TritonAI Harness settings so the Codex provider is enabled, stale non-Codex providers are disabled, and the harness defaults to `deepseek-v4-flash` through UCSD.
6. Copies bundled UCSD skills into `~/.tritonai-harness/codex/skills/`.
7. Writes a defaults patcher that keeps fresh and previously configured installs on the managed Codex provider.
8. Creates shared `.agents` guidance, logs, environment files, and a T3 launcher.
9. Installs the branded TritonAI Harness desktop build and exposes it to users as `TritonAI Harness`: `/Applications/TritonAI Harness.app` on macOS, or a `TritonAI Harness` desktop shortcut on Windows.

## Requirements

- macOS or Windows for installer runtime behavior.
- Node.js/npm for local development of this Electron scaffold.
- Network access for runtime bootstrap and staging packaged release assets during local development.

The packaged installer should not require a preinstalled system Node.js. It downloads pinned Node.js `v22.22.2` into `~/.agents/ucsd/runtime/node`, verifies the release checksum, and uses that private runtime to run the bundled managed Codex CLI.

## Local Development

```sh
npm install
npm run validate
npm start
```

Use `npm install` for local development. Use `npm ci` in CI and release packaging so the lockfile is authoritative.

## Testing

```sh
npm test
npm run test:clean-runtime
```

`npm test` runs scaffold validation, npm package-age verification, and a clean-home dry run. The dry run covers the bundled managed Codex path, bundled skill install, stale provider-cache cleanup, and managed private install fallback behavior.

The tests use temporary home directories so they do not depend on this Mac already having Node, npm, Codex, TritonAI Harness, or existing user config. See `docs/testing.md` for the full VM and CI testing notes.

## Packaging

macOS distribution uses Developer ID signing and notarization:

```sh
export UCSD_AI_BASE_URL="..."
export UCSD_AI_DOCS_URL="..."
npm run package:mac-release
npm run serve:mac-release
```

That command builds `artifacts/macos-release/UCSD-AI-Tools-Installer-<version>-arm64.dmg`, signs the app, notarizes the app and DMG, staples the notarization ticket, validates Gatekeeper, and writes `SHA256SUMS.txt`.
The managed endpoint and help URL are written into an ignored packaged config file during packaging, so public source does not carry the deployment URL.
Installed builds use the packaged config. Runtime env overrides require `UCSD_ALLOW_MANAGED_CONFIG_ENV=1` and are intended only for local development/testing.

For fast VM iteration while testing installer behavior, use the unnotarized test path:

```sh
npm run package:mac-fast-test
npm run serve:mac-fast-test
```

Windows packaging has two build paths:

```sh
npm run package:win-portable
npm run package:win-installer
```

The macOS and Windows package builds stage the branded TritonAI Harness desktop build from the `dbalders/TritonAI-Harness` release under `vendor/t3code-desktop/`, Codex CLI payloads under `vendor/codex-cli/`, and UCSD Skills Library skills under `vendor/skills/`. Windows packaging requires the Harness release to publish compatible `latest.yml` and `*-x64.exe` assets; it should fail instead of silently falling back to upstream desktop assets.

Skill contents are intentionally not committed here. The packaging scripts run `npm run prepare:skills-vendor`, which prefers a nearby local `UCSD-Skills-Library` checkout, then falls back to cloning `https://github.com/dbalders/UCSD-Skills-Library.git` `main`. It stages every packageable `<source>/<lowercase-hyphen-name>/SKILL.md` folder from `skills/` or `tritonai/` into the installer and skips template or invalidly named folders.

## Current Tool Versions

- Codex CLI backend: `@openai/codex@0.141.0`, staged into macOS and Windows installer payloads with npm's package-age cutoff, then copied into the versioned UCSD prefix at install time.
- TritonAI Harness desktop build: latest branded `dbalders/TritonAI-Harness` release for both macOS and Windows.
- UCSD Skills Library: nearby local checkout when present, otherwise latest `main` from `dbalders/UCSD-Skills-Library`, staged at package time.

Tool package staging is pinned to reviewed package versions. Codex vendor staging uses `--before=2026-06-18T21:15:00.000Z` so release assets do not float to packages published after the cutoff. Endpoint installs use the live npm command only when a development or unpackaged app is missing the bundled Codex payload.

## Managed Locations

- Shared UCSD agent home: `~/.agents/ucsd/`
- Shared env file: `~/.agents/ucsd/env` or `%USERPROFILE%\.agents\ucsd\env.ps1`
- Bundled Node/npm runtime: `~/.agents/ucsd/runtime/node/`
- Managed Codex CLI: `~/.agents/ucsd/runtime/codex/openai-codex-0.141.0/`
- Codex home: `~/.tritonai-harness/codex`
- UCSD skills: `~/.tritonai-harness/codex/skills/`
- TritonAI Harness settings: `~/.tritonai-harness/userdata/settings.json`
- TritonAI Harness launcher: `/Applications/TritonAI Harness.app` on macOS, or a `TritonAI Harness` desktop shortcut on Windows

## Security Notes

API keys must never be committed to this repository. The installer stores user keys in user-level environment configuration because that matches the requested flow. A production hardening pass should support OS keychain storage or short-lived UCSD gateway tokens.

Deployment-specific managed config is generated into `build/managed-config.generated.json`, which is intentionally ignored. Signing keys, certificates, API keys, packaged desktop payloads, staged skills, and release artifacts are also ignored.

See `docs/security-model.md` for the current guardrails and hardening backlog.
