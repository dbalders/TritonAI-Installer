# Run Installer packaging without an agent loop

The release runner wraps the existing commands. It adds dependency ordering, per-step logs,
checksummed completion receipts, resume, and a single handoff directory. It does not change
release pins, signing policy, package validation, or publication order. The runner uses plain Node
CommonJS so packaging can clean and rebuild `dist/` without deleting its orchestration entrypoints.

## Standard Installer recipe

Start after preparing and verifying the exact Harness Mac/Windows artifacts using the existing
release sequence. Commit the Installer release version first. Keep the normal release environment
(plugin ref/commit/configuration, secure skills source, signing and Windows toolchain setup).
Additionally set `TRITONAI_PLUGINS_SOURCE` to the clean pinned plugin checkout and
`RELEASE_HARNESS_ASSETS` to the directory containing the verified Harness handoff.

From the clean Installer release checkout:

```sh
npm run release:prepare -- /absolute/path/to/new-candidate
npm run release:run -- /absolute/path/to/new-candidate/release.json --dry-run
npm run release:run -- /absolute/path/to/new-candidate/release.json
```

Preparation hashes the verified Harness handoff once; both platform stages must match that exact
hash, even on their first run. It creates separate Mac and Windows Installer worktrees at the same current commit.
It never changes versions or chooses newer source refs. The recipe:

1. Optionally waits for the **existing** Harness release CI run identified by
   `TRITONAI_HARNESS_RUN_ID` and `TRITONAI_HARNESS_COMMIT`. It checks repository/workflow/commit,
   waits with `gh run watch --exit-status`, and reads back the result. It never dispatches a run.
2. Installs dependencies concurrently in the isolated worktrees.
3. Runs the Installer test suite once before either packaging stage.
4. Runs the existing signed/notarized Mac packaging and explicitly unsigned Windows packaging.
5. Copies the final artifacts and packaging proofs into `handoff/mac` and `handoff/win`, verifying
   their hashes and refusing to replace different bytes.

The verified local Harness artifacts are still required when using the optional CI wait; the wait
is a gate, not an asset download or proof that those local bytes were built by that CI run.
Packaging itself verifies the existing Harness artifact/composition contract.

Both packaging stages share an exclusive resource because local Electron Builder/Wine/NSIS caches
can overlap. Dependency setup is parallel; packaging is sequential by default. Do not remove that
resource until the build caches and toolchains are actually isolated. `--jobs 1` serializes everything.

The existing macOS signing credentials and Windows/Wine toolchain must already be configured.
This helper does not install or replace the shared NSIS launcher. Run the standard recipe on the
Mac release host with the existing cross-build setup.

## Resume and diagnosis

Rerun the exact same `release:run` command after fixing an operational failure. Successful stages
are skipped only after matching the recipe, runner, clean source commits, declared input hashes,
release environment hashes, and output hashes. Failed stages rerun their existing command from
the beginning; completed stages do not rebuild. A failure in one parallel stage stops new work
and lets already-running independent commands finish before returning failure.

Receipts and logs live in `release.json.run/`. The command prints one line per stage and a short
summary. Read the failed stage's log instead of repeatedly polling tools or reading full build logs
through an agent. Environment values are not written to the receipt; underlying command logs may
contain sensitive diagnostics, so keep this directory private. Do not commit generated recipes,
logs, artifacts, or state.

Changed source/configuration, missing or modified completed outputs, or an edited recipe require a
fresh candidate. The runner deliberately refuses to silently rebuild previously verified bytes.
If forcibly interrupted, confirm that the recorded runner PID and its children have stopped before
removing `release.json.run/runner.lock`. Never start another runner over live packaging work. Failed preparation removes the fresh worktrees
it created so the same command can be retried; unexpected files or changed worktrees are retained
and reported for inspection. Mac credential environment values and notarization config/key files
are included in the resume checks without storing their contents in receipts.

## Scope and remaining release steps

This automates Installer preparation, source tests, packaging, and local artifact handoff. Harness
Mac signing/packaging, native Windows transfer and boot verification, and GitHub publication remain
in the existing release procedure. In particular, `complete` means the recipe completed; it is not
release approval or native Windows launch proof. Run `verify:win-installer:native` on the transferred
exact Windows artifacts and retain its proof before publication. Nothing here publishes 0.3.4.

The runner can also execute trusted local recipes for other existing release commands. Each step
has an `id`, absolute `cwd`, `commands` (arrays of argv), `needs`, and explicit `outputs`. Optional
`inputs` hash files/directories, `sources` verify clean Git checkouts, `requiredEnv` binds external
configuration, and `resources` prevents concurrent use of shared build tools. Commands run without
a shell; put any required shell logic in a reviewed script. Relative inputs/outputs resolve against
that step's cwd. Keep all generated outputs in ignored directories or outside the source checkout.
Only use `git: false` for steps that genuinely have no Git source.
