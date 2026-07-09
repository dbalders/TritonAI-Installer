# Continual Testing

The installer should not be validated against a developer laptop as the primary signal. A developer machine usually already has Node, npm, shells, PATH entries, app configs, and cached packages.

## Local Tests

Fast local check:

```sh
npm test
```

This runs:

- Syntax/scaffold validation.
- npm package-age verification against the supply-chain cutoff.
- A clean-home dry run that writes all configs into a temp directory and injects fake command execution.

Runtime bootstrap check:

```sh
npm run test:clean-runtime
```

This creates a temp home directory, strips PATH down to OS basics, downloads the pinned Node.js runtime, verifies the checksum, extracts it, and proves the private `node` and `npm` run.

## What This Catches

- Accidental writes to the real user home.
- Missing clean-machine folders.
- Tool installs that are not pinned.
- Missing npm `--before` cutoff.
- Config files that stop being generated.
- Private Node/npm bootstrap regressions.
- Regressions where TritonAI Harness keeps a stale legacy provider-status cache.
- Regressions where the installer uses a random system `codex` instead of the managed UCSD Codex path.
- Regressions where the managed Codex backend is missing, stale, copied from the wrong packaged payload, or falls back to npm without the package-age cutoff.

## Legacy Provider Stale-State Reproduction

Do not use the developer laptop home directory as the primary reproduction. The clean dry-run test creates a temp home, seeds the failure shape, and verifies the installer behavior without touching `~/.t3` or `~/.agents`.

The dry run now covers:

- A stale provider cache at `.tritonai-harness/caches/legacy-provider.json` reporting `version: 1.4.3` and `status: error`, which should be cleared during the Codex migration.
- A managed Codex binary that reports `0.140.0` and should be upgraded.
- A current managed Codex binary that reports `0.141.0` and should not reinstall.
- A packaged Codex payload that should be copied instead of running npm during a normal packaged install.
- A missing packaged Codex payload that should use the pinned npm fallback only for development/unpackaged runs.
- A separate system `codex` outside the versioned managed prefix, which must not become TritonAI Harness's selected backend.
- macOS and Windows settings, including the managed `codex` or `codex.cmd` path and `~/.tritonai-harness/codex` home.

Run the reproduction with:

```sh
npm run test:clean-dry-run
```

## CI Shape

Run the same checks on hosted clean machines:

- `macos-latest`: `npm ci`, `npm test`, `npm run test:clean-runtime`
- `windows-latest`: `npm ci`, `npm test`, `npm run test:clean-runtime`

The runtime test intentionally uses a temporary home, so it is safe for CI and does not depend on whatever the runner image already has installed.

## Release Gate

Before distributing a signed installer, run one manual VM test per platform:

1. Start from a fresh macOS or Windows VM snapshot.
2. Install nothing manually.
3. Run the packaged installer.
4. Confirm `~/.agents/ucsd` and `~/.tritonai-harness` are created.
5. Confirm TritonAI Harness launches from the desktop/application launcher.
6. Confirm configs point at UCSD/TritonAI and do not use default vendor endpoints.
7. Revert the VM snapshot.

## UTM macOS VM Handoff

Keep `UCSD Installer Clean macOS` as the stopped baseline. For each installer test, clone it and run the clone:

```sh
utmctl clone "UCSD Installer Clean macOS" --name "UCSD Installer Test Run"
utmctl start "UCSD Installer Test Run"
```

Build the Developer ID signed and notarized macOS release DMG, then serve only that release
artifact from the host Mac:

```sh
npm run package:mac-release
npm run serve:mac-release
```

The serve command validates the stapled DMG before opening the HTTP server and prints the URL to
use from the VM. In the VM, download the installer from Safari using that printed URL, for example:

```text
http://192.168.64.1:8790/TritonAI-Installer-0.1.0-arm64.dmg
```

If Safari searches instead of downloading, use Terminal in the VM with the printed URL:

```sh
cd ~/Desktop
curl -fL -o TritonAI-Installer.dmg \
  http://192.168.64.1:8790/TritonAI-Installer-0.1.0-arm64.dmg
open TritonAI-Installer.dmg
```

Do not hand off `dist/mac-arm64`, ad-hoc builds, copied `.app` bundles, or `artifacts/macos-share`
to the VM. Clean macOS downloads should use the signed and notarized DMG under
`artifacts/macos-release/` only.

UTM's Shared Folder button opens the host-side folder picker. It is useful if the guest mounts the shared folder, but this macOS Apple Virtualization VM did not expose the selected folder under `/Volumes` during testing. The HTTP handoff above is the reliable path.

After the run, stop and delete only the disposable clone:

```sh
utmctl stop "UCSD Installer Test Run"
utmctl delete "UCSD Installer Test Run"
```
