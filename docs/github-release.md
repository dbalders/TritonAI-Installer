# GitHub Installer releases

The `Installer release` workflow builds macOS arm64 and Windows x64 on GitHub-hosted runners. Harness must already be published. The workflow creates a verified **draft**; publication remains a separate release action.

## One-time configuration

Create `macos-signing` and `windows-signing` environments, each restricted to the `main` branch. Follow [Windows signing](windows-artifact-signing.md) for a dedicated Installer OIDC identity, exact environment subject and profile-scoped signer role.

Repository secrets used by both build jobs:

- `UCSD_AI_BASE_URL`: the managed service URL used by the released Harness.
- `HARNESS_ACTIONS_READ_TOKEN`: fine-grained access to Harness with Actions read.
- `SECURE_SKILLS_READ_TOKEN`: fine-grained access to UCSD-Skills-Library-Secure with Contents read.

`macos-signing` environment secrets:

- `MAC_CERTIFICATE`: base64-encoded Developer ID Application PKCS#12 identity.
- `MAC_CERTIFICATE_PASSWORD` and `DEVELOPER_ID_APPLICATION`.
- `APPLE_API_KEY`: notarization key contents, plus `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.

`windows-signing` environment variables are the seven `AZURE_*` values listed in the Windows signing guide. Windows authenticates with OIDC; no Azure client secret is used.

## Build a release

1. Merge the reviewed Installer source, including its committed package version.
2. Select a published stable Harness release and its successful `release.yml` run. Both tag-triggered runs and controlled manual runs on Harness main are accepted, provided the tag resolves to the run's exact commit.
3. Select the reviewed secure-skills commit. Start `Installer release` on `main` with the two versions, Harness run ID, Harness commit and secure-skills commit.
4. Wait for both builds and the draft job. Mac verifies Developer ID signing, notarization, stapling, Gatekeeper and native packaged boot. Windows verifies publisher, trusted timestamp and Setup/portable native packaged boot. Both compare every consumed Harness input against artifacts from the selected run and enforce the bundled Codex policy and plugin composition.
5. Review the draft and perform intended installation/upgrade UAT. Publish the draft through GitHub Releases when approved.

The final Windows job rechecks signatures and both boot proofs, generates `SHA256SUMS.txt`, and reads back every draft asset's size and SHA-256. It publishes only the five release-contract files plus checksums. Intermediate artifacts retain the candidate binaries and verification inputs for seven days; source credentials and private skills checkouts are excluded. The Installer binaries themselves contain the intended bundled skills, just like local release builds.

An existing release blocks a new build, including an existing draft. Inspect failed runs and any partially created draft before retrying. Do not delete or replace a public release to bypass this guard. A run can be retried from failed jobs before draft creation; an already-created partial draft requires deliberate reconciliation with the original candidate bytes using the existing publisher.

## Verified Harness 0.3.4 inputs

- Harness run: `35795214512`
- Harness commit: `313db55bb01179cd7a9282325f66ee85580a8be9`
- Installer and Harness versions: `0.3.4`

These identify the published Harness inspected on September 22, 2026. Recheck release status and ensure the run artifacts have not expired before dispatch. A secure-skills commit must still be selected and reviewed.
