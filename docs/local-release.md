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
  "outputRoot": "/absolute/TritonAI-builds",
  "developerId": "Your Developer ID name (TEAMID)",
  "minimumFreeGiB": 35
}
```

The configuration file contains an object per plugin ID with its build configuration.
Keep credentials out of Git. The runner loads this file, validates the selected plugins'
configuration before packaging, and stores its hash in the candidate record. It never
searches transcripts, old apps, or unrelated files for missing configuration.

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

Repeat the same command to resume an interrupted candidate. It keeps the original source
commits even if main moved. Completed stages are reused only while input, source, environment,
recipe, and output hashes match. Failed stages restart their own commands. `--fresh` creates
a new timestamped candidate with newly resolved sources; `--output /absolute/new-directory`
chooses a specific location. A forcibly killed process may leave a lock: confirm its recorded
PID and children have stopped before removing that candidate's lock.

The source test gate runs non-server tests with two workers, then runs the server
suite with its own serial SQLite/Git test configuration. Both groups must pass.
Node, Vite+, and Wine resolve to immutable executable paths and hashes; a changed executable
or Windows compiler receipt requires a fresh candidate. Notarization credentials are added
only to macOS signing/package commands.

The output folder contains `candidate.json`, `release.json`, per-stage logs and receipts,
and `handoff/` with platform artifacts, SHA-256 checksums and `report.json`. The Mac Harness
helper checks the final signed/notarized DMG and updater ZIP, actual plugin bytes, and an
isolated packaged boot. Windows extraction verifies actual plugin payload bytes; native
Windows installation/boot remains explicitly unverified until `verify:win-installer:native`
runs against the exact outputs on Windows.

Candidate worktrees carry a persistent local-candidate marker. The public publishing commands
reject those worktrees, including after their environment variables are cleared. Publishing
is a separately authorized operation with its existing reviewed catalog and verification gates.
