# TritonAI Installer

Cross-platform Electron installer for [**TritonAI Harness**](https://github.com/dbalders/TritonAI-Harness) on macOS and Windows. The packaged app is named **UCSD AI Tools Installer** and gives UC San Diego users a guided setup without requiring a system Node.js installation or manual configuration.

The installer:

- Installs the branded TritonAI Harness desktop app.
- Provides private, managed Node.js and Codex runtimes.
- Configures TritonAI access and managed defaults.
- Installs bundled UCSD skills.

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
npm run validate
npm test
npm start
```

Use `npm ci` instead of `npm install` in CI and release packaging.

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

Release builds stage TritonAI Harness, Codex, and UCSD Skills Library assets into the installer. Publish the Harness release before building the installer so those assets are available.

## Documentation

- [Architecture](docs/architecture.md)
- [Testing and VM validation](docs/testing.md)
- [Repository setup](docs/repository-setup.md)
- [Security model](docs/security-model.md)

Do not commit API keys, signing credentials, generated managed config, vendored payloads, or release artifacts.
