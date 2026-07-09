# Next Steps

The installer now targets TritonAI Harness with a managed Codex backend. The next pass should focus on clean-machine verification and release polish.

## Verify Codex Migration

- Confirm a clean macOS package installs TritonAI Harness, writes Codex settings, and opens with Codex selected on a fresh machine.
- Re-run the clean dry run after any harness settings changes to verify stale legacy provider caches are cleared.
- Confirm the packaged macOS app includes `vendor/codex-cli/mac-arm64` and copies it into the versioned managed Codex path.
- Confirm `~/.tritonai-harness/codex` is the only Codex home used by the packaged app.

## Finish Windows Support

- Validate the Windows portable and installer packaging paths against the same `dbalders/TritonAI-Harness` release source.
- Test the bundled `vendor/codex-cli/win-x64` payload and versioned managed Codex path on a clean Windows VM.
- Confirm the Windows TritonAI Harness install path, launcher detection, and shortcut behavior.
- Run the Windows clean-runtime test path and document any manual steps or blockers.

## Release Hygiene

- Make future release tags match the package version before packaging.
- Package from a clean committed tree.
- After upload, verify the GitHub release is published, marked latest, and that the uploaded DMG/ZIP checksums match the local artifacts.
