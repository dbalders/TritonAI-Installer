# Feature Complete Checklist

## TritonAI Harness Only Installer

- [x] Remove separate Codex, Claude, and legacy provider desktop install paths.
- [x] Keep Codex CLI as the TritonAI Harness backend dependency.
- [x] Use an installer-owned managed Codex CLI path instead of arbitrary system Codex installs.
- [x] Write TritonAI Harness settings that route Codex through UCSD/TritonAI.
- [x] Default TritonAI Harness to `deepseek-v4-flash`.
- [x] Remove onboarding tool choices.
- [x] Bundle TritonAI Harness Desktop and the managed Codex CLI in packaged artifacts.
- [x] Pull latest `main` from `dbalders/UCSD-Skills-Library` during packaging.
- [x] Install bundled UCSD skills into the managed Codex home.
- [ ] Verify end-to-end on clean macOS and Windows VMs with a real UCSD/TritonAI key.
