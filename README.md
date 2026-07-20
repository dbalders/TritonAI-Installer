# TritonAI Installer

Cross-platform Electron installer for [**TritonAI Harness**](https://github.com/dbalders/TritonAI-Harness) on macOS and Windows. The packaged app is named **TritonAI Installer** and gives UC San Diego users a guided setup without requiring a system Node.js installation or manual configuration.

The installer:

- Installs the branded TritonAI Harness desktop app.
- Provides private, managed Node.js and Codex runtimes.
- Configures TritonAI access and managed defaults.
- Installs the reviewed secure skills bundled from the private UCSD skills repository.
- Verifies that the bundled Harness release statically includes the exact reviewed TritonAI plugin packages selected for that Installer release.

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
Harness vendoring also requires an explicit, immutable source contract. Set `TRITONAI_HARNESS_VERSION`
and either one `TRITONAI_HARNESS_RELEASE_BASE` or both canonical platform-specific release bases.
The vendoring command does not infer a version or use a moving latest-release URL.
Packaged builds use the canonical `edu.ucsd.tritonai.installer` application identifier; legacy Installer product identifiers are not migration inputs for this new product.

Managed plugins have a separate, fail-closed source contract. Stable macOS and Windows release
packaging resolves the highest canonical `vMAJOR.MINOR.PATCH` Plugins tag at the start of the run,
freezes its exact commit, and selects the production `microsoft-365` package. Every Harness release
must publish an artifact-bound composition proof for that exact selection. A moving branch such as
`main` and nearby `TritonAI-Plugins` checkouts are never used automatically.
Production package inclusion remains an explicit reviewed Installer allowlist, so publishing an
experimental package does not silently add it to desktop releases.

For an exact rebuild or a preselected composition, set all three values below. Complete explicit
pins override automatic latest-release selection:

```sh
export TRITONAI_PLUGINS_REF="refs/tags/v0.1.0"
export TRITONAI_PLUGINS_COMMIT="<full 40-character commit SHA>"
export TRITONAI_PLUGIN_IDS="microsoft-365"
```

`TRITONAI_PLUGINS_REPO` may select another transport URL only when Git resolves it to canonical
`github.com/dbalders/TritonAI-Plugins`. `TRITONAI_PLUGINS_SOURCE` is an explicit release-machine
override and is accepted only for a clean Git checkout with that canonical origin, the pinned HEAD,
and a ref resolving to the same commit. Dirty local validation work is rejected.

`npm run prepare:plugins-vendor` retains the explicit/manual behavior above; without pins it disables
managed plugins for a development build. Stable packaging invokes the same tool with `--latest`.
It validates and atomically stages only selected release package
contents under ignored `vendor/plugins/`. It rejects symlinks, special files, unsafe paths,
source/tests in package allowlists or provider output, malformed manifests, package/manifest drift,
and skill/manifest drift. The staged packages are a Harness build input, not an Installer runtime
payload.

The Harness build must statically compose those packages into its immutable catalog. After all
signing, notarization, and stapling, it publishes `tritonai-plugin-composition-mac-arm64.json` and
`tritonai-plugin-composition-win-x64.json`. Each proof contains the exact generated
`vendor/plugins/manifest.json` composition plus the filename, size, and SHA-512 of that platform's
final release artifact. Installer packaging downloads the matching platform proof, stores it beside
the Harness artifact as `tritonai-plugin-composition.json`, and rechecks it when the packaged
Installer runs. This preserves the Harness trust model: the Installer never adds a dynamic loader
and never installs raw plugin code that Harness cannot use.

macOS:

```sh
npm run package:mac-release
```

Windows:

```sh
npm run package:win-installer
```

Stable Windows packaging is fail-closed. It requires the seven Azure Trusted Signing environment
values, enables Electron Builder `forceCodeSigning`, verifies Authenticode on the
Setup, portable, and unpacked application executables, and writes a hash-bound verification proof.
`npm run release:contract` must run on Windows; it rejects artifacts that do not match that proof
and independently re-verifies the exact release executables against the pinned UCSD publisher.
Direct unsigned
Electron Builder runs are development outputs and are not distributable release artifacts.
The legacy portable ZIP is available only as `package:win-portable:unsigned-dev` and additionally
requires `TRITONAI_ALLOW_UNSIGNED_WINDOWS_DEV_BUILD=1`.

Required release environment variables:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` (exact certificate Common Name)

Release builds stage TritonAI Harness, Codex, secure skills from the private `dbalders/UCSD-Skills-Library-Secure` repository, and a build-only reviewed plugin composition from canonical `dbalders/TritonAI-Plugins`. Public AI Team and Community skills are discovered and installed by TritonAI Harness; they are not bundled into the Installer.

The secure repository uses root-level `<skill-name>/SKILL.md` folders. For a trusted local packaging checkout, set `UCSD_SKILLS_SOURCE` explicitly:

```sh
UCSD_SKILLS_SOURCE="/path/to/UCSD-Skills-Library-Secure" npm run prepare:skills-vendor
```

`UCSD_SKILLS_REPO`, `UCSD_SKILLS_REF`, and `UCSD_SKILLS_SUBDIR` remain available for controlled build and test overrides. Without a usable local checkout, packaging clones private repository `main` using the release machine's existing Git credentials.

At runtime the Installer owns only the secure skill names recorded in `~/.tritonai-harness/codex/skills/.tritonai-managed-skills.json`. Upgrades replace or remove only those owned directories. Existing public, community, and user-added skills are preserved, and an unowned name collision stops the install for explicit resolution.

Publish the Harness release before building the Installer so the intended Harness assets are available.

After both platforms are packaged and available on the Windows release host, run
`npm run release:contract`. The machine-readable
[`release-artifacts.json`](release-artifacts.json) contract requires the canonical
`TritonAI-Installer-*` DMG, Windows Setup, portable EXE, Setup blockmap, and Windows update
manifest. It writes one `artifacts/SHA256SUMS.txt` with relative basenames only. The GitHub
release helper validates that the requested tag, package version, and `HEAD` identify the same
commit, uploads every contracted platform asset without `--clobber`, and refuses to modify an
already-published release.

## Documentation

- [Architecture](docs/architecture.md)
- [Testing and VM validation](docs/testing.md)
- [Repository setup](docs/repository-setup.md)
- [Security model](docs/security-model.md)

Do not commit API keys, signing credentials, generated managed config, vendored payloads, or release artifacts.
