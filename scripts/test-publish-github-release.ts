const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  buildDesiredReleaseAssets,
  createGitHubClient,
  planAssetReconciliation,
  publishDraftRelease
} = require("./publish-github-release");

function main() {
  withFixture(({ desired, paths }) => {
    assertFreshDraft(paths);
    assertPartialDraft(desired, paths);
    assertCompleteDraft(desired, paths);
    assertLostUploadResponse(paths);
    assertStarterRecovery(desired, paths);
    assertMismatchFailures(desired);
    assertOperationalFailures(paths);
    assertLookupStatusHandling();
  });
  console.log("GitHub draft release publication tests passed.");
}

function assertFreshDraft(paths) {
  const github = mockGitHub(null);
  const result = publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github });
  assert.strictEqual(github.created.length, 1);
  assert.deepStrictEqual(github.uploaded.sort(), paths.map((file) => path.basename(file)).sort());
  assert.strictEqual(result.created, true);
  assert.strictEqual(result.noOp, false);
  assert(github.lookupCount >= 3, "fresh publication must refetch and verify the final asset set");
}

function assertPartialDraft(desired, paths) {
  const github = mockGitHub(draftRelease([uploadedAsset(desired[0], 1)]));
  const result = publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github });
  assert.deepStrictEqual(github.uploaded, [desired[1].name]);
  assert.strictEqual(result.uploaded, 1);
  assert.strictEqual(result.noOp, false);
}

function assertCompleteDraft(desired, paths) {
  const github = mockGitHub(draftRelease(desired.map((asset, index) => uploadedAsset(asset, index + 1))));
  const result = publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github });
  assert.deepStrictEqual(github.uploaded, []);
  assert.deepStrictEqual(github.deleted, []);
  assert.strictEqual(result.noOp, true);
  assert(github.lookupCount >= 3, "complete reruns must still refetch and verify the final set");
}

function assertLostUploadResponse(paths) {
  const github = mockGitHub(draftRelease([]), { loseUploadResponse: new Set([path.basename(paths[0])]) });
  const result = publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github });
  assert.deepStrictEqual(github.uploaded.sort(), paths.map((file) => path.basename(file)).sort());
  assert.strictEqual(result.uploaded, 2);
}

function assertStarterRecovery(desired, paths) {
  const starter = { id: 17, name: desired[0].name, state: "starter", size: 0, digest: null };
  const github = mockGitHub(draftRelease([starter, uploadedAsset(desired[1], 18)]));
  const result = publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github });
  assert.deepStrictEqual(github.deleted, [17]);
  assert.deepStrictEqual(github.uploaded, [desired[0].name]);
  assert.strictEqual(result.removedStarters, 1);
}

function assertMismatchFailures(desired) {
  const first = desired[0];
  assert.throws(
    () => planAssetReconciliation(draftRelease([{ ...uploadedAsset(first, 1), size: first.size + 1 }]), [first]),
    /size mismatch/
  );
  assert.throws(
    () => planAssetReconciliation(draftRelease([{ ...uploadedAsset(first, 1), digest: `sha256:${"f".repeat(64)}` }]), [first]),
    /SHA-256 mismatch/
  );
  assert.throws(
    () => planAssetReconciliation(draftRelease([{ ...uploadedAsset(first, 1), digest: null }]), [first]),
    /missing a valid SHA-256 digest/
  );
  assert.throws(
    () => planAssetReconciliation(draftRelease([uploadedAsset(first, 1), uploadedAsset(first, 2)]), [first]),
    /duplicate asset name/
  );
  assert.throws(
    () => planAssetReconciliation(draftRelease([{ ...uploadedAsset(first, 1), name: "unexpected.bin" }]), [first]),
    /unexpected assets/
  );
  assert.throws(
    () => planAssetReconciliation({ ...draftRelease([]), draft: false }, [first]),
    /published GitHub release/
  );
  assert.throws(
    () => planAssetReconciliation(draftRelease([{ ...uploadedAsset(first, 1), state: "starter", size: 1 }]), [first]),
    /unsupported state/
  );
}

function assertOperationalFailures(paths) {
  const lookupFailure = mockGitHub(null, { lookupError: new Error("GitHub lookup failed with HTTP 503") });
  assert.throws(
    () => publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github: lookupFailure }),
    /HTTP 503/
  );

  const uploadFailure = mockGitHub(draftRelease([]), { failUpload: new Set([path.basename(paths[0])]) });
  assert.throws(
    () => publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github: uploadFailure }),
    /simulated upload failure/
  );

  const finalMutation = mockGitHub(draftRelease([]), { addUnexpectedOnLookup: 3 });
  assert.throws(
    () => publishDraftRelease({ tag: "v0.2.5", head: "a".repeat(40), assetPaths: paths, github: finalMutation }),
    /unexpected assets/
  );
}

function assertLookupStatusHandling() {
  const notFound = createGitHubClient(() => ({ status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }));
  assert.strictEqual(notFound.lookupRelease("v0.2.5"), null);

  const forbidden = createGitHubClient(() => ({ status: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" }));
  assert.throws(() => forbidden.lookupRelease("v0.2.5"), /HTTP 403/);
}

function mockGitHub(initialRelease, options: any = {}) {
  let release = clone(initialRelease);
  let nextId = 100;
  const state = {
    created: [],
    deleted: [],
    uploaded: [],
    lookupCount: 0,
    lookupRelease() {
      state.lookupCount += 1;
      if (options.lookupError) throw options.lookupError;
      if (options.addUnexpectedOnLookup === state.lookupCount && release) {
        release.assets.push({
          id: nextId++,
          name: "unexpected.bin",
          state: "uploaded",
          size: 1,
          digest: `sha256:${"e".repeat(64)}`
        });
      }
      return clone(release);
    },
    createDraftRelease(releaseTag, head) {
      state.created.push({ releaseTag, head });
      release = draftRelease([]);
    },
    deleteAsset(assetId) {
      state.deleted.push(assetId);
      release.assets = release.assets.filter((asset) => asset.id !== assetId);
    },
    uploadAsset(_releaseTag, desired) {
      state.uploaded.push(desired.name);
      if (options.failUpload?.has(desired.name)) {
        throw new Error(`simulated upload failure for ${desired.name}`);
      }
      release.assets.push(uploadedAsset(desired, nextId++));
      if (options.loseUploadResponse?.has(desired.name)) {
        throw new Error(`simulated lost upload response for ${desired.name}`);
      }
    }
  };
  return state;
}

function draftRelease(assets) {
  return { id: 42, draft: true, assets };
}

function uploadedAsset(desired, id) {
  return {
    id,
    name: desired.name,
    state: "uploaded",
    size: desired.size,
    digest: `sha256:${desired.sha256}`
  };
}

function withFixture(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tritonai-release-publish-"));
  try {
    const paths = [path.join(tempRoot, "installer.dmg"), path.join(tempRoot, "SHA256SUMS.txt")];
    fs.writeFileSync(paths[0], "installer fixture\n");
    fs.writeFileSync(paths[1], "checksum fixture\n");
    callback({ paths, desired: buildDesiredReleaseAssets(paths) });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

main();
