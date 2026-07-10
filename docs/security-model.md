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
- Validate the versioned vendor manifest, skill names, directories, and required `SKILL.md` files before mutating an existing install, and stage the complete replacement set before activation.
- Route TritonAI Harness through Codex by setting the provider instance to `codex`, passing `UCSD_AI_BASE_URL` and `TRITONAI_API_KEY`, exposing TritonAI-routed Codex models, defaulting to `deepseek-v4-flash`, and disabling stale non-Codex provider entries.
- Avoid relying on Homebrew, system Node, or global machine package state.

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
