# Windows Artifact Signing

The Installer has a local release runner, not the Harness release workflow. Its
macOS/Wine local Windows lane remains explicitly unsigned. The native Windows
`package:win-installer:signed` lane now supports Azure CLI authentication after
GitHub OIDC login. Native signing and verification require PowerShell 7
(`pwsh.exe`) on PATH, as provided by the hosted Windows runner. It never falls
back to the unsigned lane.

## Packaging and validation

`Windows signing validation` is a manual, non-publishing workflow on Installer
`main`. It requires explicit Installer/Harness stable versions, the exact Harness
commit and successful tag-triggered `release.yml` run ID, and a reviewed secure
skills commit. It checks that the Harness tag still resolves to that commit and
that the stable release is published with all required Windows assets. It separately
downloads `desktop-win-x64` from that exact workflow run and compares all three
consumed release inputs (manifest, executable, plugin proof) byte-for-byte using
SHA-512 and size before activating the vendor payload. Replaced release assets
fail even if they are internally consistent and carry a valid signature. Expired
or missing run artifacts fail closed; there is no release-only fallback. A nightly,
draft, failed run, unrelated workflow, or missing asset stops packaging. Dispatch
only after Harness finishes; this workflow does not create or publish Harness.

Existing vendoring then verifies the downloaded Harness version, size, SHA-512,
platform-specific plugin composition and artifact binding, valid Authenticode
signature, exact publisher and timestamp. Production plugins remain pinned by
`config/managed-plugin-catalog.json`; a composition mismatch requires an explicit
reviewed catalog update, never bypassing the check. Private secure skills are
checked out at the requested commit and staged with the existing clean-source gate.

Electron Builder 26.15.7 uses `win.azureSignOptions` and `forceCodeSigning` to sign
the application, NSIS uninstaller, Setup and portable executable during packaging.
Its NSIS target awaits Setup signing before generating the Setup blockmap. Do not
post-sign finished artifacts. The script verifies the final application, Setup
and portable signatures against `The Regents of the University of California`,
requires a signer certificate and trusted timestamp, writes `authenticode-signatures.json`
with SHA-256 hashes, and generates `latest.yml` from the signed Setup bytes.
Native Setup and portable boot verification must also pass. Missing configuration,
signing failures, invalid signatures and failed boot checks fail the workflow.

Successful runs retain only `latest.yml`, `authenticode-signatures.json` and
`packaged-boot.json`, plus `harness-run-binding.json` for seven days as Actions artifacts. This repository is public:
never upload the candidate executables, archives or private secure-skills source.
The reports contain hashes and verification metadata, not private skill content.
Candidates remain on the ephemeral runner and are discarded when it is destroyed;
use separately approved private storage if candidate retention is needed.
Repository contents are read-only (`contents: read`); the validation job also
has `id-token: write` to request the Azure OIDC token. It never invokes release publication.
Inspect all three signatures and `packaged-boot.json` before considering signing
proven. The separate cross-platform `release:contract`/publication process still applies.

## Signing and release-input access

1. Reuse the existing **TritonAI Harness GitHub Signing** Entra application
   (`4ad54335-1df2-4084-a433-2db43efde436`) in tenant
   `8a198873-4fec-4e76-8182-ca479edbbd60`. It already has the profile-scoped
   signer role below. Do not create another signing account, certificate profile,
   client secret, or human signer assignment for Installer.
2. Add an exact federated identity credential:
   - issuer: `https://token.actions.githubusercontent.com`
   - audience: `api://AzureADTokenExchange`
   - subject: `repo:dbalders/TritonAI-Installer:environment:windows-signing`
3. Verify the existing **Artifact Signing Certificate Profile Signer** assignment
   on the shared service principal is at this profile scope only:

   ```text
   /subscriptions/3e0cad08-e45d-4882-a3aa-c1504d4e5017/resourceGroups/TritonAI/providers/Microsoft.CodeSigning/codeSigningAccounts/ucsd-tritonai-signing/certificateProfiles/tritonai-public
   ```

   Resolve the role-definition ID, explicitly checking the legacy name if the
   current name is absent. Run this in an authorized administrator's Azure CLI
   session with the correct tenant/subscription selected; set
   `INSTALLER_SIGNER_OBJECT_ID` to the service principal's **object ID**, not its
   application client ID:

   ```sh
   role_id=$(az role definition list --name 'Artifact Signing Certificate Profile Signer' --query '[0].name' --output tsv)
   if [ -z "$role_id" ]; then
     role_id=$(az role definition list --name 'Trusted Signing Certificate Profile Signer' --query '[0].name' --output tsv)
   fi
   if [ -z "$role_id" ]; then
     echo 'Neither signer role definition was found; stop provisioning.' >&2
     exit 1
   fi
   az role assignment create \
     --assignee-object-id "$INSTALLER_SIGNER_OBJECT_ID" \
     --assignee-principal-type ServicePrincipal \
     --role "$role_id" \
     --scope '/subscriptions/3e0cad08-e45d-4882-a3aa-c1504d4e5017/resourceGroups/TritonAI/providers/Microsoft.CodeSigning/codeSigningAccounts/ucsd-tritonai-signing/certificateProfiles/tritonai-public'
   ```

   Do not grant subscription Owner or Contributor to the CI identity.
4. Create Installer's `windows-signing` GitHub environment **before dispatch**.
   Configure selected deployment branches/tags to allow the `main` **branch
   only**, no tags. No per-build reviewer approval is required, matching the
   existing Harness release process. Keep administrator bypass disabled. An environment OIDC subject does not itself restrict branches.
   Keep main protected by PR checks/review. The workflow also rejects non-main
   runs. Do not add wildcard PR, fork, tag, or repository subjects to Azure.
5. Set these environment variables:

   | Variable | Value |
   | --- | --- |
   | `AZURE_CLIENT_ID` | Existing Harness signing application client ID |
   | `AZURE_TENANT_ID` | `8a198873-4fec-4e76-8182-ca479edbbd60` |
   | `AZURE_SUBSCRIPTION_ID` | `3e0cad08-e45d-4882-a3aa-c1504d4e5017` |
   | `AZURE_TRUSTED_SIGNING_ENDPOINT` | `https://wus2.codesigning.azure.net/` |
   | `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | `ucsd-tritonai-signing` |
   | `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | `tritonai-public` |
   | `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME` | `The Regents of the University of California` |

   Use the existing TritonAI Harness GitHub App for cross-repository inputs.
   Set `RELEASE_INPUT_APP_ID` as an environment variable and
   `RELEASE_INPUT_APP_PRIVATE_KEY` as an environment secret. The App installation
   must include Harness with Actions read and UCSD-Skills-Library-Secure with
   Contents read. The workflow explicitly narrows each generated token to one
   repository and its required read permission, then revokes it during cleanup.
   Checkout disables credential persistence. No permanent personal token or
   `AZURE_CLIENT_SECRET` is used.
6. Ensure Windows runners can install PowerShell's TrustedSigning module and
   reach Azure CLI, the signing endpoint, Microsoft timestamp service, GitHub,
   npm and the existing runtime download sources. Electron Builder installs
   TrustedSigning >=0.5.0 in its selected PowerShell host.
7. After the code is merged and provisioning is complete, run the manual
   validation workflow against main using a **signed stable Harness release**
   produced by a successful tag-triggered run. It is intentionally not runnable
   with signing privileges from this PR. No merge or dispatch is part of this PR.

For an already authenticated native Windows release machine, set
`AZURE_TRUSTED_SIGNING_USE_AZURE_CLI=true` and the signing variables above, then
run `npm run package:win-installer:signed` with explicit Harness source/version and
secure-skills source. The legacy service-principal secret mode remains available
when the CLI flag is absent/false. CLI mode rejects a supplied client secret.
Both modes use identical in-packaging signing and post-build verification.

## Evidence boundary

Installer reuses the Harness signing application, profile and publisher. Its
exact environment federation and seven Azure variables were configured and read
back on September 22, 2026. The existing GitHub App was also verified with
separate repository-scoped Actions-read and Contents-read tokens. These access
checks do not prove Installer signing or packaged boot; a successful hosted
release and its verification reports remain required. Actual installation and
upgrade UAT are separate from packaged boot checks.

References: [Electron Builder v26 Windows signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/),
[Microsoft OIDC setup](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md),
[Microsoft profile-scoped signer role](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles).
