# Next Steps

The installer now targets TritonAI Harness with a managed Codex backend. The next pass should focus on clean-machine verification and release polish.

## Verify Codex Migration

- Confirm a clean macOS package installs TritonAI Harness, writes Codex settings, and opens with Codex selected on a fresh machine.
- Re-run the clean dry run after any harness settings changes to verify stale legacy provider caches are cleared.
- Confirm the packaged macOS app includes `vendor/codex-cli/mac-arm64` and copies it into the versioned managed Codex path.
- Confirm the packaged macOS app includes `vendor/node-runtime/mac-arm64` and installs successfully with `nodejs.org` blocked.
- Confirm `~/.tritonai-harness/codex` is the only Codex home used by the packaged app.

## Finish Windows Support

- Build the explicit unsigned Windows candidate through the supported macOS/Wine path, transfer its exact proof-listed bytes to a clean native Windows release host, run `npm run verify:win-installer:native`, and preserve both proofs plus the SmartScreen warning with every release.
- When Azure Trusted Signing is provisioned, run the separate signed lane and publisher-bound release contract without removing the unsigned fallback until the signed path is proven on clean Windows.
- Test the bundled `vendor/codex-cli/win-x64` payload and versioned managed Codex path on a clean Windows VM.
- Test the bundled `vendor/node-runtime/win-x64` payload with `nodejs.org` blocked and verify retry after an interrupted Installer run.
- Confirm the Windows TritonAI Harness install path, launcher detection, and shortcut behavior.
- Complete the full key-authenticated Windows install in a clean VM after the non-destructive Setup and portable boot gate passes.

## Release Hygiene

- Make future release tags match the package version before packaging.
- Package from a clean committed tree.
- After upload, verify the GitHub release is published, marked latest, and that the uploaded DMG/ZIP checksums match the local artifacts.
