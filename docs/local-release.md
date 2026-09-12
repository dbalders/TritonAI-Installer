# Build local Mac and Windows candidates

From the Installer checkout containing this workflow:

```sh
npm run release:local -- 0.3.4
```

The command fetches Harness and Installer `origin/main`, selects the Installer catalog's
plugin commit and the secure skills repository's `origin/main`, freezes those commits, and
builds macOS arm64 and unsigned Windows x64 candidates. Dirty development checkouts are
preserved: work happens in isolated detached worktrees. Only release version files are
committed locally in those worktrees. No tags, pushes, workflow dispatches, uploads, or
GitHub releases occur.

For a Harness-only candidate, use:

```sh
npm run release:local -- 0.3.4 --scope harness
```

`--scope full` is the default. `--scope harness` builds and verifies both Harness platforms,
but excludes Installer dependency installs, tests, app compilation, packaging, and skills
checkout/validation. It still pins the Installer repository as the owner of the reviewed
plugin catalog and composition producer. Only that small producer is compiled, using
Harness's installed TypeScript compiler and Node types. Windows packaging tools also
resolve from Harness's Electron Builder dependency, so Installer dependencies are unnecessary.

The intended cadence is Harness nightlies plus full releases, with Installer only on full
releases alongside the matching verified Harness. This local scope switch does not create a
nightly schedule or GitHub workflow; the local candidate command still accepts stable versions.

Select Harness and Installer commits containing these changes together when testing before
merge: `--harness FULL_SHA --installer FULL_SHA`. Older Harness scripts do not support the
new source-only staging flag; older Installer sources lack the small producer configuration.

Choose another plugin or skills version with a remote tag, branch, or full commit:

```sh
npm run release:local -- 0.3.4 --plugins v0.1.3 --skills refs/heads/main
```

`--plugins` selects a version of the plugin repository; package IDs come from the selected
Installer catalog. The generated candidate catalog records the actual package versions
and digests from that commit. `--skills` selects the secure skills repository version.
`--harness` and `--installer` also accept explicit refs when testing a reviewed fix. An
ambiguous tag/branch name requires `refs/tags/NAME` or `refs/heads/NAME`. There is no local
branch fallback when a remote ref is missing.

## Configure the release host once

Save `~/.config/tritonai/release.json` (or supply `--profile /absolute/file.json`):

```json
{
  "schemaVersion": 1,
  "pluginConfigurationFile": "/absolute/private/plugin-configuration.json",
  "installerConfiguration": {
    "baseUrl": "https://tritonai-api.ucsd.edu/v1"
  },
  "outputRoot": "/absolute/TritonAI-builds",
  "developerId": "Your Developer ID name (TEAMID)",
  "minimumFreeGiB": 35
}
```

The configuration file contains an object per plugin ID with its build configuration.
Keep credentials out of Git. The runner loads this file, validates the selected plugins'
configuration before packaging, and stores its hash in the candidate record. It never
searches transcripts, old apps, or unrelated files for missing configuration.

For full candidates, `installerConfiguration.baseUrl` is required and sets the Installer's managed API URL.
Optional `apiDocsUrl`, `codexModel`, `restrictedCodexModel`, and `externalModelProbe` fields
override the corresponding Installer settings. Omit optional fields to use the selected
Installer source's defaults. These values come only from the profile and are frozen in
`candidate.json`; ambient environment variables cannot supply or override them. Resuming
uses the original candidate values even if the profile changes. Use `--fresh` to select
new values or replace an older candidate that lacks frozen Installer configuration.

The host needs Node 24, Vite+ (`vp`), Git, Xcode command-line tools, a Developer ID signing
identity, Wine (`wine64`), Rust 1.95 or newer, and `cargo-xwin`. Rust needs the
`aarch64-apple-darwin` and `x86_64-pc-windows-msvc` targets. The runner finds installed Node 24 under nvm and `vp` under
`~/.vite-plus/bin`; optional `node`, `vp`, and `wine` profile fields select absolute paths.
Notarization uses `~/.agents/secrets/appstore/config.json` or the profile's
`notarizationConfig` path, with `keyFile`, `keyId`, and `issuerId` fields. Optional
`repositories` fields (`harness`, `installer`, `plugins`, `skills`) override sibling paths.
Preflight checks npm/Corepack, system packaging utilities, Rust, and the selected Xcode
and Windows cross-compilation tools before dependency installation starts. Rustup proxies
resolve to actual toolchain binaries before freezing; optional `cargo` and `rustc` profile
fields pin those paths explicitly. `cargoXwin`, `clang`, and `lldLink` can also select exact
cross-build executables. A broken Homebrew Rust installation does not override these tools.

Windows tooling is provisioned from Electron Builder's checksum-verified official downloads.
NSIS 3.0.4.1's compiler is verified against its pinned SHA-256 on every use. Each platform
has its own Electron cache, temporary directory, build outputs, and worktrees; Windows
has its own Wine prefix and compiler launcher. Shared tool caches are never patched.
The Windows resource monitor is compiled from the frozen Harness source with the MSVC
target using `cargo-xwin`, a candidate-owned Microsoft SDK cache, and the selected Xcode
compiler and Rust linker. Its source, tool, and binary hashes accompany the handoff.
The native cache path must contain no spaces for the supported cargo-xwin invocation;
use an output root such as `~/Documents/TritonAI-builds`.

## Check, run, resume

```sh
npm run release:local -- 0.3.4 --check
npm run release:local -- 0.3.4 --plan
npm run release:local -- 0.3.4
npm run release:local -- 0.3.4 --status
```

After configuration and source gates, Mac and Windows build concurrently. Each Installer
starts when its own Harness artifact is ready. `--jobs 1` serializes stages on a constrained
machine. Preflight reports missing prerequisites and insufficient space before builds start.

Repeat the same command, including `--scope harness` when applicable, to resume an interrupted
candidate. Scope is frozen and cannot change on resume. Default output locations are separate:
`local-VERSION` for full releases and `local-harness-VERSION` for Harness-only candidates. It keeps the original source
commits even if main moved. Completed stages are reused only while input, source, environment,
recipe, and output hashes match. Failed stages restart their own commands. `--fresh` creates
a new timestamped candidate with newly resolved sources; `--output /absolute/new-directory`
chooses a specific location. A forcibly killed process may leave a lock: confirm its recorded
PID and children have stopped before removing that candidate's lock.

The source test gate runs non-server tests with two workers, then runs the server
suite with its own serial SQLite/Git test configuration. Both groups must pass.
Source checks run lint and typecheck as well. Compilation happens in each platform's
packaging stage using its exact managed configuration; source checks do not run an
additional workspace build that packaging would discard.
The Installer's npm publication-date check deduplicates package/version lookups within
one invocation and queries at most six at a time. Every invocation still queries npm;
missing dates and registry errors still fail the gate.
Node, Vite+, and Wine resolve to immutable executable paths and hashes; a changed executable
or Windows compiler receipt requires a fresh candidate. Notarization credentials are added
only to macOS signing/package commands.

The output folder contains `candidate.json`, `release.json`, per-stage logs and receipts,
and `prepare.run/timings.jsonl` / `build.run/timings.jsonl` with timestamped command and
macOS packaging measurements. Timing records contain labels, duration, and completion
status, never command arguments or credentials. Some phases contain timed substeps;
their durations overlap and must not be summed. Stage receipts preserve prior attempts
and failed-stage durations when a candidate is resumed.

Mac Harness preparation uses `build-desktop-artifact.ts --platform mac --target zip
--keep-stage --stage-only` to compile and stage its source and pinned runtime dependencies.
It writes the composition input proof and returns before Electron Builder. The release
finalizer runs Electron Builder once to package/sign the app and produce the updater ZIP,
then checks the final app's update configuration and native binaries before creating the
DMG. Signing, notarization, packaged boot, payload checks, and final artifact proofs remain
required. No unsigned Harness ZIP is generated and discarded.

The Mac Installer packages a signed, notarized app directory directly, then creates,
signs, notarizes, and verifies the final DMG. It does not generate a discarded Installer
ZIP. Harness's updater ZIP remains a required release artifact.

The output folder also contains `handoff/` with platform artifacts, SHA-256 checksums and `report.json`. The Mac Harness
helper checks the final signed/notarized DMG and updater ZIP, actual plugin bytes, and an
isolated packaged boot. Windows extraction verifies actual plugin payload bytes; native
Windows installation/boot remains explicitly unverified until `verify:win-installer:native`
runs against the exact outputs on Windows.
For full candidates, both Windows Installer EXEs are also extracted and checked for the exact bundled Harness,
skills, Codex CLI, Node runtime, and managed configuration. The handoff retains that proof.

Candidate worktrees carry a persistent local-candidate marker. The public publishing commands
reject those worktrees, including after their environment variables are cleared. Publishing
is a separately authorized operation with its existing reviewed catalog and verification gates.
