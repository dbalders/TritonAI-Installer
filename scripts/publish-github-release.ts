const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  assertReleaseMayBeUpdated,
  assertReleaseSourceIdentity,
  writeReleaseChecksumManifest
} = require("./release-contract");

const root = path.resolve(__dirname, "..", "..");
const tag = process.argv[2];
const pkg = require(path.join(root, "package.json"));
const GITHUB_REPOSITORY = "dbalders/TritonAI-Installer";

function main() {
  if (!tag) {
    throw new Error("Usage: npm run release:github -- v0.1.0");
  }

  const sourceIdentity = assertReleaseSourceIdentity({
    root,
    tag,
    version: pkg.version,
    remoteTaggedCommit: getRemoteTagCommit(tag)
  });
  const contract = writeReleaseChecksumManifest({ root, version: pkg.version });
  const assetPaths = [
    ...contract.artifacts.map((entry) => entry.absolutePath),
    contract.manifestPath
  ];
  const result = publishDraftRelease({
    tag,
    head: sourceIdentity.head,
    assetPaths,
    github: createGitHubClient()
  });

  if (result.noOp) {
    console.log(`GitHub draft release ${tag} already has the exact verified asset set; no upload was needed.`);
  } else {
    console.log(
      `Reconciled GitHub draft release ${tag}: preserved ${result.preserved}, `
      + `uploaded ${result.uploaded}, removed ${result.removedStarters} empty starter asset(s).`
    );
  }
}

function publishDraftRelease({ tag: releaseTag, head, assetPaths, github }) {
  const desired = buildDesiredReleaseAssets(assetPaths);
  let release = github.lookupRelease(releaseTag);
  let created = false;

  if (!release) {
    try {
      github.createDraftRelease(releaseTag, head);
      created = true;
    } catch (error) {
      release = github.lookupRelease(releaseTag);
      if (!release) throw error;
    }
    release = release || github.lookupRelease(releaseTag);
    if (!release) {
      throw new Error(`GitHub draft release ${releaseTag} was not found after creation.`);
    }
  }

  const initialPlan = planAssetReconciliation(release, desired);
  for (const starter of initialPlan.removeStarters) {
    try {
      github.deleteAsset(starter.id);
    } catch (error) {
      const afterDelete = requireRelease(github.lookupRelease(releaseTag), releaseTag);
      if (afterDelete.assets.some((asset) => asset.id === starter.id)) throw error;
    }
  }

  release = requireRelease(github.lookupRelease(releaseTag), releaseTag);
  const uploadPlan = planAssetReconciliation(release, desired);
  for (const asset of uploadPlan.upload) {
    try {
      github.uploadAsset(releaseTag, asset);
    } catch (error) {
      const afterUpload = requireRelease(github.lookupRelease(releaseTag), releaseTag);
      const retryPlan = planAssetReconciliation(afterUpload, desired);
      if (retryPlan.upload.some((entry) => entry.name === asset.name)) throw error;
    }
  }

  const finalRelease = requireRelease(github.lookupRelease(releaseTag), releaseTag);
  const finalPlan = planAssetReconciliation(finalRelease, desired);
  if (finalPlan.upload.length > 0 || finalPlan.removeStarters.length > 0) {
    throw new Error(
      `GitHub draft release ${releaseTag} does not have the exact final asset set; `
      + `missing: ${finalPlan.upload.map((asset) => asset.name).join(", ") || "none"}.`
    );
  }

  return {
    created,
    noOp: !created && initialPlan.upload.length === 0 && initialPlan.removeStarters.length === 0,
    preserved: initialPlan.preserve.length,
    uploaded: uploadPlan.upload.length,
    removedStarters: initialPlan.removeStarters.length
  };
}

function planAssetReconciliation(release, desiredAssets) {
  assertReleaseMayBeUpdated(release);
  if (!Array.isArray(release.assets)) {
    throw new Error("GitHub draft release response is missing its asset list.");
  }

  const desiredByName = uniqueByName(desiredAssets, "desired release assets");
  const existingByName = uniqueByName(release.assets, "existing GitHub release assets");
  const unexpected = Array.from(existingByName.keys()).filter((name) => !desiredByName.has(name));
  if (unexpected.length > 0) {
    throw new Error(`GitHub draft release contains unexpected assets: ${unexpected.sort().join(", ")}.`);
  }

  const plan = { preserve: [], upload: [], removeStarters: [] };
  for (const desired of desiredAssets) {
    const existing = existingByName.get(desired.name);
    if (!existing) {
      plan.upload.push(desired);
      continue;
    }
    if (existing.state === "starter" && existing.size === 0) {
      if (!Number.isInteger(existing.id)) {
        throw new Error(`Empty starter asset ${desired.name} has no valid asset id.`);
      }
      plan.removeStarters.push(existing);
      plan.upload.push(desired);
      continue;
    }
    if (existing.state !== "uploaded") {
      throw new Error(`GitHub asset ${desired.name} has unsupported state ${JSON.stringify(existing.state)}.`);
    }
    if (existing.size !== desired.size) {
      throw new Error(`GitHub asset ${desired.name} size mismatch: expected ${desired.size}, found ${existing.size}.`);
    }
    const digest = parseSha256Digest(existing.digest, desired.name);
    if (digest !== desired.sha256) {
      throw new Error(`GitHub asset ${desired.name} SHA-256 mismatch.`);
    }
    plan.preserve.push(desired);
  }
  return plan;
}

function buildDesiredReleaseAssets(assetPaths) {
  const assets = assetPaths.map((absolutePath) => {
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
      throw new Error(`Release asset must be a non-empty regular file: ${absolutePath}`);
    }
    return {
      name: path.basename(absolutePath),
      absolutePath,
      size: stat.size,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")
    };
  });
  uniqueByName(assets, "desired release assets");
  return assets;
}

function uniqueByName(assets, label) {
  const byName = new Map();
  for (const asset of assets) {
    if (!asset || typeof asset.name !== "string" || !asset.name) {
      throw new Error(`${label} contain an asset without a valid name.`);
    }
    if (byName.has(asset.name)) {
      throw new Error(`${label} contain duplicate asset name ${asset.name}.`);
    }
    byName.set(asset.name, asset);
  }
  return byName;
}

function parseSha256Digest(value, assetName) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`GitHub asset ${assetName} is missing a valid SHA-256 digest.`);
  }
  return value.slice("sha256:".length).toLowerCase();
}

function requireRelease(release, releaseTag) {
  if (!release) throw new Error(`GitHub draft release ${releaseTag} disappeared during reconciliation.`);
  return release;
}

function createGitHubClient(spawn: any = spawnSync) {
  return {
    lookupRelease(releaseTag) {
      const endpoint = `repos/${GITHUB_REPOSITORY}/releases/tags/${encodeURIComponent(releaseTag)}`;
      const result = spawn("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      if (result.error) throw result.error;
      if (result.status === 0) {
        try {
          return JSON.parse(result.stdout);
        } catch (error) {
          throw new Error(`GitHub release lookup returned invalid JSON for ${releaseTag}: ${error.message}`);
        }
      }
      const detail = String(result.stderr || "").trim();
      if (/\bHTTP 404\b/.test(detail)) return null;
      throw new Error(`Could not inspect GitHub release ${releaseTag}: ${detail || `gh exited ${result.status}`}`);
    },
    createDraftRelease(releaseTag, head) {
      run("gh", [
        "release",
        "create",
        releaseTag,
        "--repo",
        GITHUB_REPOSITORY,
        "--draft",
        "--target",
        head,
        "--title",
        `TritonAI Installer ${releaseTag}`,
        "--notes",
        "macOS and Windows TritonAI Installer artifacts."
      ]);
    },
    deleteAsset(assetId) {
      run("gh", ["api", "--method", "DELETE", `repos/${GITHUB_REPOSITORY}/releases/assets/${assetId}`]);
    },
    uploadAsset(releaseTag, asset) {
      run("gh", ["release", "upload", releaseTag, asset.absolutePath, "--repo", GITHUB_REPOSITORY]);
    }
  };
}

function getRemoteTagCommit(releaseTag) {
  const result = spawnSync("git", [
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${releaseTag}`,
    `refs/tags/${releaseTag}^{}`
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Could not inspect remote release tag ${releaseTag}: ${String(result.stderr || "").trim()}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}^{}`));
  const direct = lines.find((line) => line.endsWith(`refs/tags/${releaseTag}`));
  return (peeled || direct || "").split(/\s+/)[0] || null;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

if (require.main === module) main();

module.exports = {
  GITHUB_REPOSITORY,
  buildDesiredReleaseAssets,
  createGitHubClient,
  getRemoteTagCommit,
  planAssetReconciliation,
  publishDraftRelease
};
