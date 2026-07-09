# Feature Complete Checklist

## TritonAI Harness Only Installer

- [x] Remove separate Codex, Claude, and legacy provider desktop install paths.
- [x] Keep Codex CLI as the TritonAI Harness backend dependency.
- [x] Use an installer-owned managed Codex CLI path instead of arbitrary system Codex installs.
- [x] Write TritonAI Harness settings that route Codex through UCSD/TritonAI.
- [x] Default TritonAI Harness to `deepseek-v4-flash`.
- [x] Remove onboarding tool choices.
- [x] Bundle TritonAI Harness Desktop and the managed Codex CLI in packaged artifacts.
- [x] Pull secure root-level skills from private `dbalders/UCSD-Skills-Library-Secure` during packaging; do not bundle public repository skills.
- [x] Install bundled secure skills into the managed Codex home with a versioned ownership manifest.
- [x] Preserve public, community, and user-added skill directories across Installer upgrades.
- [x] Replace/remove only previously Installer-owned secure skills and reject unowned name collisions.
- [x] Migrate old installs by removing the legacy root `manifest.json` without removing its public skill directories.
- [ ] Verify end-to-end on clean macOS and Windows VMs with a real UCSD/TritonAI key.
