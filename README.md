# TritonAI Installer

Cross-platform Electron installer for [**TritonAI Harness**](https://github.com/dbalders/TritonAI-Harness) on macOS and Windows. The packaged app is named **TritonAI Installer** and gives UC San Diego users a guided setup without requiring a system Node.js installation or manual configuration.

Created and maintained by David Balderston for UC San Diego.

The installer:

- Installs the branded TritonAI Harness desktop app.
- Provides private, managed Node.js and Codex runtimes.
- Configures TritonAI access and managed defaults.
- Installs the reviewed secure skills bundled from the private UCSD skills repository.
- Verifies that the bundled Harness release statically includes the exact reviewed TritonAI plugin packages selected for that Installer release.

Users need a TritonAI API key and network access to verify TritonAI access. Packaged installers carry the pinned Node.js and Codex runtimes; they do not download Node.js during setup.

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

Release packaging requires the managed TritonAI endpoint. macOS also requires its Apple signing and
notarization credentials; Windows currently supports the explicit unsigned lane documented below.
Harness vendoring also requires an explicit, immutable source contract. Set `TRITONAI_HARNESS_VERSION`
and either one `TRITONAI_HARNESS_RELEASE_BASE` or both canonical platform-specific release bases.
The vendoring command does not infer a version or use a moving latest-release URL.
Packaged builds use the canonical `edu.ucsd.tritonai.installer` application identifier; legacy Installer product identifiers are not migration inputs for this new product.

Managed plugins have a separate, fail-closed source contract. Stable macOS and Windows packaging
uses the reviewed `config/managed-plugin-catalog.json`, which pins the exact Plugins ref, commit,
package versions, package digests, and manifest digests. Production
selection is stable and required as one composition; unenforced per-package policy metadata is
intentionally rejected. Every Harness release must publish an
artifact-bound composition proof for those exact bytes. Publishing a package or placing it in the
source tree never approves it for production.

For an exact rebuild or a preselected composition, set all three values below. Complete explicit
pins override automatic latest-release selection:

```sh
export TRITONAI_PLUGINS_REF="refs/tags/v0.1.0"
export TRITONAI_PLUGINS_COMMIT="<full 40-character commit SHA>"
export TRITONAI_PLUGIN_IDS="github,google-workspace,microsoft-365"
```

`TRITONAI_PLUGINS_REPO` may select another transport URL only when Git resolves it to canonical
`github.com/dbalders/TritonAI-Plugins`. `TRITONAI_PLUGINS_SOURCE` is an explicit release-machine
override and is accepted only for a clean Git checkout with that canonical origin, the pinned HEAD,
and a ref resolving to the same commit. Dirty local validation work is rejected.

`npm run prepare:plugins-vendor` retains the explicit/manual behavior above; without pins it disables
managed plugins for a development build. `--latest` is a candidate-build convenience that keeps the
catalog's package selection while resolving a newer stable source tag. Stable packaging uses
`--production`, rejects source overrides, and verifies the staged bytes against the reviewed catalog.
It validates and atomically stages only selected release package contents under ignored
`vendor/plugins/`. Harness v2 packages keep their legacy allowlisted layout. SDK v1 packages are
copied byte-for-byte from `artifacts/<plugin-id>/`; the Installer does not compile, import, or
semantically validate provider code. It rejects symlinks, special files, unsafe paths,
source/tests in package allowlists or provider output, malformed manifests, package/manifest drift,
and skill/manifest drift. The staged packages are a Harness build input, not an Installer runtime
payload. Provider packages expose their exact manifest and synchronous
`createIntegrationProvider({ secrets, configuration })` factory from `dist/index.js`; the Installer
does not import factories or interpret package-owned configuration.

The Harness build must compose those exact packages into its immutable catalog. After all
signing, notarization, and stapling, it publishes `tritonai-plugin-composition-mac-arm64.json` and
`tritonai-plugin-composition-win-x64.json`. Each proof contains the exact generated
`vendor/plugins/manifest.json` composition plus the filename, size, and SHA-512 of that platform's
final release artifact. Installer packaging downloads the matching platform proof, stores it beside
the Harness artifact as `tritonai-plugin-composition.json`, and rechecks it when the packaged
Installer runs. This preserves the Harness trust model: the Installer never adds a dynamic loader
or runtime discovery path and never installs raw plugin code separately from the reviewed Harness
artifact.

macOS:

```sh
npm run package:mac-release
```

The macOS command keeps Electron Builder responsible for assembling and signing the application,
then creates the distributable DMG from a clean source folder with Apple's `hdiutil`. This avoids
copying a sealed app into a mounted writable volume. After notarization and stapling it mounts the
exact final DMG, verifies Gatekeeper and the inner signature, launches the packaged Installer in a
non-destructive readiness mode for five seconds, and records a SHA-256-bound boot proof.

Windows packaging (macOS/Wine or Windows):

```powershell
$env:TRITONAI_ALLOW_UNSIGNED_WINDOWS_RELEASE = "1"
npm run package:win-installer
```

Until UC San Diego's Windows artifact-signing identity is provisioned, this is the explicit unsigned
release lane. It refuses to run without the opt-in above, rejects ambiguous signing credentials,
vendors a Harness release whose exact version, size, SHA-512, and plugin composition are frozen, and
writes `artifacts/windows-installer/unsigned-release.json` with SHA-256 evidence for every output
plus a distributable `SHA256SUMS-windows-unsigned.txt`. It also validates the Setup and portable PE
structures. Packaging does not claim that the Windows applications launched.

Transfer the four proof-listed outputs, `unsigned-release.json`, and
`SHA256SUMS-windows-unsigned.txt` without rebuilding them to a clean native Windows host, then run:

```powershell
npm run verify:win-installer:native
```

The native verifier re-hashes the exact proof-listed bytes before execution, refuses to replace an
existing Installer, boots the portable candidate, silently installs the Setup candidate, boots the
installed app for five seconds, uninstalls it, verifies cleanup, and writes `packaged-boot.json`.
These artifacts are intentionally unsigned and may trigger Microsoft Defender SmartScreen. Do not
describe them as publisher-verified.

When Azure Trusted Signing becomes available, use `npm run package:win-installer:signed`. That future
lane requires all seven signing values, enables Electron Builder `forceCodeSigning`, requires the
nested Harness to carry the pinned UCSD publisher and a trusted timestamp, re-verifies the staged
payload and installed Harness, and writes publisher-bound proof. `npm run release:contract` remains
the stricter signed cross-platform publication gate and is not satisfied by unsigned proof.

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

Release builds stage TritonAI Harness, the pinned Node.js and Codex runtimes, secure skills from the private `dbalders/UCSD-Skills-Library-Secure` repository, and a build-only reviewed plugin composition from canonical `dbalders/TritonAI-Plugins`. Public AI Team and Community skills are discovered and installed by TritonAI Harness; they are not bundled into the Installer. Stable packaging refuses a dirty local secure-skills checkout and records the exact resolved Git commit; a new skills commit is required only when skills content changes. `prepare-node-runtime-vendor` downloads Node at build time and requires both the official release checksum and archive to match a repository-reviewed per-platform SHA-256 before recording the exact platform manifest. Platform payloads ship as real `extraResources` outside ASAR so native macOS and Windows tools never receive virtual archive paths. Runtime activation is transactional; packaged installs fail closed if that payload is missing or invalid. Live download remains only as an atomic, timeout-bounded development fallback.

Every packaged Windows build includes an artifact-bound trust policy. Current unsigned releases
skip only Authenticode checks and emit a visible warning; version, size, SHA-512, plugin-composition,
installed-version, and upgrade-replacement checks remain mandatory. Signed builds require the nested
Harness NSIS publisher `University of California San Diego` and trusted timestamp, then repeat that
identity check on the staged NSIS payload and installed Harness executable before creating a launcher.
Missing, malformed, or artifact-mismatched policy files fail closed.

The secure repository uses root-level `<skill-name>/SKILL.md` folders. For a trusted local packaging checkout, set `UCSD_SKILLS_SOURCE` explicitly:

```sh
UCSD_SKILLS_SOURCE="/path/to/UCSD-Skills-Library-Secure" npm run prepare:skills-vendor
```

`UCSD_SKILLS_REPO`, `UCSD_SKILLS_REF`, and `UCSD_SKILLS_SUBDIR` remain available for controlled build and test overrides. Without a usable local checkout, packaging clones private repository `main` using the release machine's existing Git credentials.

At runtime the Installer owns only the secure skill names recorded in `~/.tritonai-harness/codex/skills/.tritonai-managed-skills.json`. Upgrades replace or remove only those owned directories. Existing public, community, and user-added skills are preserved, and an unowned name collision stops the install for explicit resolution.

During installation, a per-user Electron lock prevents two Installer processes from racing, normal
window-close and quit requests are held until the current transaction finishes or reports a safe retry,
and a second in-process install request is rejected. Renderer progress delivery
and support-report persistence are deliberately non-authoritative observers, so a UI crash or log
write failure cannot abort otherwise valid package/runtime mutation. Support reports classify the
failing owner component as well as the step while continuing to redact the submitted access key.
Environment/profile files, migration state, managed runtime launchers, and the Windows desktop shortcut are staged and replaced atomically, and durable transaction journals let a later run
commit or roll back interrupted Node, Codex, managed Harness, launcher, and secure-skill swaps without
misclassifying partial Installer-owned state as user content.
Managed probes, Windows environment discovery/cleanup, Node archive extraction, and native helpers are watchdog-bounded; a timeout is
reported only after the owned process tree is confirmed stopped. The nested Windows NSIS process has a
twenty-minute deadline in both owned launch paths. If Windows blocks them, setup fails closed instead
of falling through to an unowned `cmd.exe` child; a timeout never starts the installer again.
The unpackaged development recovery path is bounded too: release downloads are atomic and retry-limited,
with capped redirects, idle and total timeouts, and a 1 MiB release-manifest limit. Packaged installs
remain fully vendored and do not depend on live Harness or Node.js downloads.

Publish the Harness release before building the Installer so the intended Harness assets are available.

After both platforms have signed artifacts and are available on the Windows release host, run
`npm run release:contract`. The machine-readable
[`release-artifacts.json`](release-artifacts.json) contract requires the canonical
`TritonAI-Installer-*` DMG, Windows Setup, portable EXE, Setup blockmap, and Windows update
manifest. The release contract also requires the macOS and Windows packaged-boot proofs to match the exact
candidate hashes and runtime version, platform, architecture, packaged status, and health window.
It writes one `artifacts/SHA256SUMS.txt` with relative basenames only. The GitHub
release helper validates that the requested tag, package version, and `HEAD` identify the same
commit, uploads every contracted platform asset without `--clobber`, and refuses to modify an
already-published release.

For the current unsigned Windows lane, retain `unsigned-release.json`,
`SHA256SUMS-windows-unsigned.txt`, and the native-Windows `packaged-boot.json` with
the release assets and publish an explicit unsigned/SmartScreen warning. Do not substitute that lane's
proof for the signed cross-platform contract.

## Documentation

- [Architecture](docs/architecture.md)
- [Testing and VM validation](docs/testing.md)
- [Repository setup](docs/repository-setup.md)
- [Security model](docs/security-model.md)

Do not commit API keys, signing credentials, generated managed config, vendored payloads, or release artifacts.
