const {
  assertCanonicalPluginRepository,
  sanitizeRepositoryUrl
} = require("./plugin-provenance");
const path = require("path");
const { isDeepStrictEqual } = require("util");

const MANAGED_PLUGIN_BUNDLE_KIND = "tritonai-harness-plugin-composition";
const MANAGED_PLUGIN_BUNDLE_VERSION = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAX_PLUGIN_FILES = 512;
const MAX_PLUGIN_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PLUGIN_PACKAGE_BYTES = 64 * 1024 * 1024;

function createManagedPluginBundleManifest({ source, packages }) {
  const manifest = {
    version: MANAGED_PLUGIN_BUNDLE_VERSION,
    kind: MANAGED_PLUGIN_BUNDLE_KIND,
    source: {
      repository: sanitizeRepositoryUrl(source.repository),
      ref: source.ref,
      commit: source.commit
    },
    packages
  };
  return validateManagedPluginBundleManifest(manifest, "Managed plugin composition manifest");
}

function validateManagedPluginBundleManifest(value, label = "Managed plugin composition manifest") {
  assertRecord(value, label);
  assertOnlyKeys(value, ["version", "kind", "source", "packages", "artifacts"], label);
  if (value.version !== MANAGED_PLUGIN_BUNDLE_VERSION || value.kind !== MANAGED_PLUGIN_BUNDLE_KIND) {
    throw new Error(`${label} has an unsupported version or kind.`);
  }

  assertRecord(value.source, `${label} source`);
  assertOnlyKeys(value.source, ["repository", "ref", "commit"], `${label} source`);
  assertCanonicalPluginRepository(value.source.repository, `${label} source.repository`);
  if (typeof value.source.ref !== "string" || !value.source.ref.trim() || /[\0\r\n]/.test(value.source.ref)) {
    throw new Error(`${label} source.ref must be a non-empty Git ref.`);
  }
  if (typeof value.source.commit !== "string" || !COMMIT.test(value.source.commit)) {
    throw new Error(`${label} source.commit must be a full lowercase Git commit SHA.`);
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error(`${label} must contain at least one selected plugin package.`);
  }

  const ids = new Set();
  let previousId = "";
  for (const plugin of value.packages) {
    assertRecord(plugin, `${label} package`);
    assertOnlyKeys(plugin, ["id", "name", "version", "digest", "files"], `${label} package`);
    if (typeof plugin.id !== "string" || !ID.test(plugin.id)) {
      throw new Error(`${label} contains an invalid plugin id.`);
    }
    if (plugin.id <= previousId || ids.has(plugin.id)) {
      throw new Error(`${label} plugin packages must be unique and sorted by id.`);
    }
    previousId = plugin.id;
    ids.add(plugin.id);
    if (plugin.name !== `@tritonai/plugin-${plugin.id}`) {
      throw new Error(`${label} package ${plugin.id} has package name drift.`);
    }
    if (typeof plugin.version !== "string" || !STABLE_SEMVER.test(plugin.version)) {
      throw new Error(`${label} package ${plugin.id} must use stable semantic versioning.`);
    }
    if (typeof plugin.digest !== "string" || !SHA256.test(plugin.digest)) {
      throw new Error(`${label} package ${plugin.id} has an invalid digest.`);
    }
    if (!Array.isArray(plugin.files) || plugin.files.length === 0 || plugin.files.length > MAX_PLUGIN_FILES) {
      throw new Error(`${label} package ${plugin.id} must list its composed files.`);
    }
    let previousPath = "";
    let totalBytes = 0;
    for (const file of plugin.files) {
      assertRecord(file, `${label} package ${plugin.id} file`);
      assertOnlyKeys(file, ["path", "sha256", "size"], `${label} package ${plugin.id} file`);
      if (!isSafeRelativePath(file.path) || file.path <= previousPath) {
        throw new Error(`${label} package ${plugin.id} file paths must be safe, unique, and sorted.`);
      }
      previousPath = file.path;
      if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
        throw new Error(`${label} package ${plugin.id} file ${file.path} has an invalid digest.`);
      }
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_PLUGIN_FILE_BYTES) {
        throw new Error(`${label} package ${plugin.id} file ${file.path} has an invalid size.`);
      }
      totalBytes += file.size;
    }
    if (totalBytes > MAX_PLUGIN_PACKAGE_BYTES) {
      throw new Error(`${label} package ${plugin.id} exceeds the managed package size limit.`);
    }
  }
  if (value.artifacts !== undefined) validateArtifacts(value.artifacts, label);
  return value;
}

function validateArtifacts(artifacts, label) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new Error(`${label} artifacts must contain at least one bound Harness release artifact.`);
  }
  const names = new Set();
  let previousName = "";
  for (const artifact of artifacts) {
    assertRecord(artifact, `${label} artifact`);
    assertOnlyKeys(artifact, ["fileName", "sha512", "size"], `${label} artifact`);
    if (typeof artifact.fileName !== "string"
      || path.basename(artifact.fileName) !== artifact.fileName
      || !/^TritonAI-Harness-.+\.(?:dmg|exe)$/.test(artifact.fileName)
      || artifact.fileName <= previousName
      || names.has(artifact.fileName)) {
      throw new Error(`${label} artifact names must be safe, unique, and sorted.`);
    }
    previousName = artifact.fileName;
    names.add(artifact.fileName);
    if (typeof artifact.sha512 !== "string" || !SHA512_BASE64.test(artifact.sha512)
      || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`${label} artifact ${artifact.fileName} has invalid checksum metadata.`);
    }
  }
}

function isSafeRelativePath(value) {
  if (typeof value !== "string" || !value || !/^[\x20-\x7e]+$/.test(value)) return false;
  if (value.startsWith("/") || value.includes("\\") || value.includes(":") || value.includes("//")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function assertMatchingPluginComposition(expected, actual, label = "TritonAI Harness plugin composition") {
  const normalizedExpected = validateManagedPluginBundleManifest(expected, "Prepared managed plugin manifest");
  const normalizedActual = validateManagedPluginBundleManifest(actual, label);
  const { artifacts: _expectedArtifacts, ...expectedComposition } = normalizedExpected;
  const { artifacts: _actualArtifacts, ...actualComposition } = normalizedActual;
  if (!isDeepStrictEqual(actualComposition, expectedComposition)) {
    throw new Error(
      `${label} does not match the exact prepared TritonAI plugin ref, commit, package selection, and file digests.`
    );
  }
  return normalizedActual;
}

function assertArtifactBinding(manifest, artifact, label = "TritonAI Harness plugin composition") {
  const normalized = validateManagedPluginBundleManifest(manifest, label);
  if (!normalized.artifacts) {
    throw new Error(`${label} is not bound to any Harness release artifacts.`);
  }
  const binding = normalized.artifacts.find((entry) => entry.fileName === artifact.fileName);
  if (!binding || binding.size !== artifact.size || binding.sha512 !== artifact.sha512) {
    throw new Error(`${label} is not bound to the exact ${artifact.fileName} release bytes.`);
  }
  return binding;
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertOnlyKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unsupported.join(", ")}.`);
  }
}

module.exports = {
  MANAGED_PLUGIN_BUNDLE_KIND,
  MANAGED_PLUGIN_BUNDLE_VERSION,
  assertArtifactBinding,
  assertMatchingPluginComposition,
  createManagedPluginBundleManifest,
  isSafeRelativePath,
  validateManagedPluginBundleManifest
};
