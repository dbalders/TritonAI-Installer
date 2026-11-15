# Repository Setup

Use this checklist when creating the new public GitHub repository from this clean source tree.

## Create The Repository

Create a new GitHub repository and push this repo as a normal fresh Git repository. Do not use GitHub import, fork, or `git push --mirror`; those paths can bring old private history or hidden refs along with them.

Recommended remote name:

```sh
git remote add origin git@github.com:dbalders/TritonAI-Installer.git
git push -u origin main
```

## GitHub Actions

The tracked workflows should run without repository secrets:

- `Installer Tests` runs `npm ci`, `npm test`, and `npm run test:clean-runtime` on macOS and Windows.
- `Issue Labels` syncs labels from `.github/workflows/issue-labels.yml`.

After the first push, confirm Actions are enabled for the repository and manually run `Issue Labels` once from the Actions tab.

## Review Integrations

Enable the review apps for `dbalders/TritonAI-Installer` after the repository
exists. Their repository configuration differs:

- CodeRabbit behavior is tracked in `.coderabbit.yaml`. Automatic review is
  disabled; request an advisory review with `@coderabbitai review` when a change
  warrants it. For public repositories, CodeRabbit applies configuration from
  the base branch, so changes to this file take effect after merge.
- Greptile is configured through its GitHub App and remains advisory; this
  repository does not track a Greptile configuration file.
- Other GitHub-native issue or PR review apps remain service-managed unless a
  reviewed repository configuration file is added intentionally.

Confirm the current service schema before changing tracked review configuration.

## Private Automation

Private maintainer automation lives outside this public repository. Add the new repo to the private automation config only after the public repo exists and the initial branch protection/review workflow is confirmed.

Expected new repo target:

```text
dbalders/TritonAI-Installer
```

Do not commit local automation docs, scripts, secrets, or generated state. `.gitignore` blocks the known private local paths.

## Moving To The UCSD Organization

The Installer, Harness, and secure skills repositories move from `dbalders` to the [UCSD organization](https://github.com/UCSD) together. Release workflows and scripts derive the owner from the running workflow (`github.repository_owner` / `GITHUB_REPOSITORY_OWNER`) and accept only `dbalders` or `UCSD`, so they work on either side of the transfer. Local release runs default to `dbalders`; set `TRITONAI_RELEASE_REPOSITORY_OWNER=UCSD` after the transfer.

Before transferring:

- Pause release requests; a release started between two transfers would look for Harness or secure skills under the wrong owner.
- Install the TritonAI Harness GitHub App on the UCSD organization with access to Harness (Actions read) and UCSD-Skills-Library-Secure (Contents read).
- Add Entra federated credentials for `repo:UCSD/TritonAI-Installer:environment:windows-signing` and `repo:UCSD/TritonAI-Harness:environment:windows-signing` beside the existing `dbalders` subjects.

Released Installers download Harness from `github.com/dbalders/TritonAI-Harness/releases/latest/download`, which GitHub redirects after the transfer. Never create a repository or fork with an old name under `dbalders`; that replaces the redirect.

## Release Setup

Release packaging uses local signing credentials and generated config that are intentionally not committed:

- `build/managed-config.generated.json`
- Apple Developer ID certificates and signing keys
- packaged `vendor/` payloads
- release artifacts under `artifacts/`

Use the package scripts in `package.json` from a trusted release machine, then publish artifacts through the release workflow once repository permissions and secrets are intentionally configured.
