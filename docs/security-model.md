# Security Model

## Current Scaffold

This project currently configures each tool at the user scope. It does not require admin privileges for the default path.

The installer creates:

- `~/.agents/ucsd/` for shared agent guidance, logs, and wrappers.
- `~/.tritonai-harness/codex/skills/` for bundled secure skills plus public/community/user skills installed through other trusted flows.
- `~/.agents/ucsd/runtime/` for a user-scoped Node.js/npm runtime and packaged managed tools.
- Codex home under `~/.tritonai-harness/codex`.
- TritonAI Harness provider settings under `~/.tritonai-harness/userdata/settings.json`.
- User environment variables for the API key, Codex home, TritonAI Harness home, and UCSD endpoint.

## Guardrails

The first-pass guardrails are config-level and file-level:

- Route model traffic through UCSD/TritonAI rather than arbitrary default providers.
- Pin packaged tools to explicit reviewed versions.
- Use npm's `--before` cutoff while staging tool payloads so transitive dependency resolution excludes packages published after the policy date.
- Pin the TypeScript toolchain exactly, verify registry signatures and attestations after dependency changes, and advance the cutoff only after reviewing newly admitted packages.
- Keep shared instructions in `~/.agents/ucsd/AGENTS.md`.
- Create `~/.agents/ucsd/logs/` as the stable local log destination.
- Write redacted installer transcripts and support reports under `~/.agents/ucsd/logs/` so users can copy a report or reveal the logs folder when setup pauses.
- Add deny/read guidance for common secret files.
- Stage reviewed secure skill folders from the private secure repository at build time. Public AI Team and Community skills are not bundled into the Installer.
- Record Installer-owned secure skill names in `.tritonai-managed-skills.json`; upgrades replace/remove only those names and reject collisions with unowned skill folders.
- Accept managed plugin code only through the canonical `dbalders/TritonAI-Plugins` repository. Stable packaging resolves the highest stable release tag once and freezes its full commit; explicit ref/commit pins remain available for exact rebuilds. Package selection and file digests are deterministic.
- Require the bundled Harness release to attest that exact plugin composition and bind the attestation to the exact DMG/EXE bytes. Raw plugin directories are never copied into the installed machine because Harness has no arbitrary runtime loader.
- On macOS, trust the configured Harness release source only for selecting bytes, not for selecting the publisher. Before vendoring and again before activating the staged app, require Apple's code-signing chain, Team ID `DTZW32QN7F`, signing identifier `edu.ucsd.tritonai.harness`, and a matching sealed `CFBundleIdentifier`. The requirement intentionally pins no leaf certificate fingerprint, so routine Developer ID certificate renewal under the same Team ID and bundle identifier remains valid.
- Leave plugin enablement, scoped credentials, managed plugin skills, retirement, and crash recovery to the Harness registry that consumes the statically composed catalog. Installer upgrades replace only the owned Harness app and preserve user and plugin state.
- Validate the versioned vendor manifest, skill names, directories, and required `SKILL.md` files before mutating an existing install, and stage the complete replacement set before activation.
- Route TritonAI Harness through Codex by setting the provider instance to `codex`, passing `UCSD_AI_BASE_URL` and `TRITONAI_API_KEY`, exposing TritonAI-routed Codex models, defaulting to `api-deepseek-v4-flash`, and disabling stale non-Codex provider entries.
- Manage only the production Harness settings at `~/.tritonai-harness/userdata/settings.json`. Current Harness and its upstream select `dev/settings.json` only when a development server URL is configured, so the production Installer does not create, replace, back up, or patch that developer-owned file.
- Treat every managed settings replacement and credential-bearing recovery backup as installing-user-only. On POSIX, an existing file must already be owned by the installing user's effective UID, and every staged, replacement, rollback, and backup file is normalized and verified as mode `0600` before content is written. macOS extended ACL grants are removed and verified absent; on Linux, the `0600` group-class mask leaves POSIX ACL named entries with no effective access without requiring optional system packages. On Windows, the existing owner must match the installing user's SID, then each empty staged file is owned by that user and receives a protected, non-inheriting DACL containing exactly one explicit allow rule granting that SID full control before content is written; the owner and DACL are verified again after each atomic rename.
- Fail closed before committing settings when ownership cannot be verified or user-only access cannot be applied. Preserve the existing JSON preflight, unknown fields, concurrent-edit detection, same-directory atomic replacement, recovery backup, multi-path rollback, and rollback-race protections.
- Avoid relying on Homebrew, system Node, or global machine package state.

## macOS Harness publisher rotation

Routine Developer ID certificate renewal needs no Installer change when the Team ID and bundle identifier remain the same. A proposed Team ID or bundle identifier change is a security-contract change: review the new public identifier and Apple signing evidence, update the pinned constants and positive/negative tests in one PR, and validate a signed Harness artifact before accepting it. Roll back a mistaken rotation by reverting that identifier change and rebuilding the Installer; do not bypass the native requirement or temporarily accept multiple publishers.

## Permissions

Default install should not need elevation. Elevation is only expected for:

- Machine-wide managed settings.
- Installing system package managers.
- Writing under `/Library/Application Support`, `/etc`, or `C:\ProgramData`.
- Installing signed desktop apps into machine-level application folders.
- Adding system-wide PATH entries rather than user PATH/profile entries.

For the first version, the app should leave OS prompts to the underlying installer or tool unless UCSD chooses a managed enterprise mode.

## Production Hardening

Before broad distribution:

- Replace long-lived env keys with OS keychain storage or short-lived UCSD gateway tokens where possible.
- Add endpoint allowlisting.
- Add signed update delivery.
- Add a UCSD-maintained package mirror or pre-vetted tarball cache for remaining development fallbacks that still use live npm resolution.
- Consider bundling the Node.js runtime in the installer package for offline installs.
- Choose a packaging toolchain whose full dependency tree satisfies the npm age policy; the first `electron-builder` attempt was removed from normal installs because the pre-cutoff tree carried known vulnerable transitive dependencies.
- Make telemetry/log upload opt-in or UCSD-policy-driven, with clear redaction rules.
- Add tamper checks for downloaded desktop app artifacts.
