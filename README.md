# TritonAI Installer

Cross-platform Electron installer for [**TritonAI Harness**](https://github.com/dbalders/TritonAI-Harness) on macOS and Windows. The packaged app is named **TritonAI Installer** and gives UC San Diego users a guided setup without requiring a system Node.js installation or manual configuration.

The installer:

- Installs the branded TritonAI Harness desktop app.
- Provides private, managed Node.js and Codex runtimes.
- Configures TritonAI access and managed defaults.
- Installs the reviewed secure skills bundled from the private UCSD skills repository.

Users need a TritonAI API key and network access during setup.

## Managed setup

TritonAI Harness is the user-facing desktop app. An installer-owned Codex CLI acts as its backend and routes model requests through UCSD/TritonAI. The managed runtime is isolated from any system Node.js or Codex installation to prevent version drift.

| Purpose | Location |
| --- | --- |
| Shared agent files and logs | `~/.agents/ucsd/` |
| Managed Node.js and Codex runtimes | `~/.agents/ucsd/runtime/` |
| Codex home and installed skills | `~/.tritonai-harness/codex/` |
| TritonAI Harness settings | `~/.tritonai-harness/userdata/` |

See the [architecture](docs/architecture.md) and [security model](docs/security-model.md) for implementation details.

## Local development

```sh
npm install
npm run typecheck
npm run build
npm run validate
npm test
npm start
```

Use `npm ci` instead of `npm install` in CI and release packaging.

TypeScript under `src/` and `scripts/` is the source of truth. `npm run build` emits the Electron application and repository scripts into the ignored `dist/` directory before launch, testing, or packaging.

## Packaging

Release packaging requires the managed TritonAI endpoint and platform signing credentials to be configured in the environment.

macOS:

```sh
npm run package:mac-release
```

Windows:

```sh
npm run package:win-installer
```

Release builds stage TritonAI Harness, Codex, and secure skills from the private `dbalders/UCSD-Skills-Library-Secure` repository. Public AI Team and Community skills are discovered and installed by TritonAI Harness; they are not bundled into the Installer.

The secure repository uses root-level `<skill-name>/SKILL.md` folders. For a trusted local packaging checkout, set `UCSD_SKILLS_SOURCE` explicitly:

```sh
UCSD_SKILLS_SOURCE="/path/to/UCSD-Skills-Library-Secure" npm run prepare:skills-vendor
```

`UCSD_SKILLS_REPO`, `UCSD_SKILLS_REF`, and `UCSD_SKILLS_SUBDIR` remain available for controlled build and test overrides. Without a usable local checkout, packaging clones private repository `main` using the release machine's existing Git credentials.

At runtime the Installer owns only the secure skill names recorded in `~/.tritonai-harness/codex/skills/.tritonai-managed-skills.json`. Upgrades replace or remove only those owned directories. Existing public, community, and user-added skills are preserved, and an unowned name collision stops the install for explicit resolution.

Publish the Harness release before building the Installer so the intended Harness assets are available.

## Documentation

- [Architecture](docs/architecture.md)
- [Testing and VM validation](docs/testing.md)
- [Repository setup](docs/repository-setup.md)
- [Security model](docs/security-model.md)

Do not commit API keys, signing credentials, generated managed config, vendored payloads, or release artifacts.
