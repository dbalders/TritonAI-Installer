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

These are GitHub App or service settings, not tracked files in this repository:

- CodeRabbit
- Greptile
- Any GitHub-native issue or PR review app configuration

Enable each app for `dbalders/TritonAI-Installer` after the repository exists. If a service supports repo-local config later, add that config in a separate PR after confirming the service schema from its current docs.

## Private Automation

Private maintainer automation lives outside this public repository. Add the new repo to the private automation config only after the public repo exists and the initial branch protection/review workflow is confirmed.

Expected new repo target:

```text
dbalders/TritonAI-Installer
```

Do not commit local automation docs, scripts, secrets, or generated state. `.gitignore` blocks the known private local paths.

## Release Setup

Release packaging uses local signing credentials and generated config that are intentionally not committed:

- `build/managed-config.generated.json`
- Apple Developer ID certificates and signing keys
- packaged `vendor/` payloads
- release artifacts under `artifacts/`

Use the package scripts in `package.json` from a trusted release machine, then publish artifacts through the release workflow once repository permissions and secrets are intentionally configured.
