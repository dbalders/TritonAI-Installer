const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { defaultAppRoot } = require("./app-root");
const { assertArtifactBinding, validateManagedPluginBundleManifest } = require("./plugin-bundle-manifest");

const PLUGIN_COMPOSITION_FILE = "tritonai-plugin-composition.json";
const PLUGIN_REQUIREMENT_FILE = "managed-plugin-composition.json";

function readPluginCompositionRequirement(options: Record<string, any> = {}) {
  const resourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const appRoot = options.appRoot || defaultAppRoot(__dirname);
  const candidates = [
    resourcesPath && path.join(resourcesPath, PLUGIN_REQUIREMENT_FILE),
    path.join(appRoot, PLUGIN_REQUIREMENT_FILE),
    path.join(appRoot, "build", "managed-plugin-composition.generated.json")
  ].filter(Boolean);
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) {
    if (options.required) throw new Error(`Packaged TritonAI Installer is missing ${PLUGIN_REQUIREMENT_FILE}.`);
    return false;
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Managed plugin composition requirement is invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || typeof value.required !== "boolean"
    || Object.keys(value).some((key) => !["version", "required"].includes(key))) {
    throw new Error("Managed plugin composition requirement has an unsupported contract.");
  }
  return value.required;
}

function inspectBundledPluginComposition(options: Record<string, any> = {}) {
  const file = findBundledPluginComposition(options);
  if (!file) {
    if (options.required) {
      throw new Error(
        `This packaged TritonAI Installer is missing ${PLUGIN_COMPOSITION_FILE}; `
        + "the bundled Harness plugin composition cannot be verified. Rebuild the Installer from a Harness release that publishes the required composition proof."
      );
    }
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Bundled Harness plugin composition is not valid JSON: ${error.message}`);
  }
  const validated = validateManagedPluginBundleManifest(manifest, "Bundled Harness plugin composition");
  verifyBundledArtifactBinding(validated, file, options);
  return validated;
}

function verifyBundledArtifactBinding(manifest, compositionFile, options) {
  if (!manifest.artifacts) {
    throw new Error("Bundled Harness plugin composition is not bound to a Harness release artifact.");
  }
  const extension = (options.platform || process.platform) === "darwin" ? ".dmg" : ".exe";
  const candidates = manifest.artifacts.filter((artifact) =>
    artifact.fileName.endsWith(extension)
      && fs.existsSync(path.join(path.dirname(compositionFile), artifact.fileName))
  );
  if (candidates.length !== 1) {
    throw new Error(`Bundled Harness plugin composition must identify exactly one co-located ${extension} artifact.`);
  }
  const [binding] = candidates;
  const artifactPath = path.join(path.dirname(compositionFile), binding.fileName);
  if (!fs.existsSync(artifactPath)) throw new Error(`Bound Harness release artifact is missing: ${binding.fileName}.`);
  const stat = fs.lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Bound Harness release artifact must be a regular file: ${binding.fileName}.`);
  }
  assertArtifactBinding(manifest, {
    fileName: binding.fileName,
    size: stat.size,
    sha512: crypto.createHash("sha512").update(fs.readFileSync(artifactPath)).digest("base64")
  }, "Bundled Harness plugin composition");
}

function findBundledPluginComposition(options: Record<string, any> = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const target = platform === "darwin"
    ? `mac-${arch}`
    : platform === "win32"
      ? `win-${arch}`
      : null;
  if (!target) return null;

  const explicitResourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const appRoot = options.appRoot || defaultAppRoot(__dirname);
  const candidates = [
    explicitResourcesPath && path.join(explicitResourcesPath, "vendor", "t3code-desktop", target, PLUGIN_COMPOSITION_FILE),
    path.join(appRoot, "vendor", "t3code-desktop", target, PLUGIN_COMPOSITION_FILE)
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      const stat = fs.lstatSync(candidate);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (_error) {
      return false;
    }
  }) || null;
}

module.exports = {
  PLUGIN_COMPOSITION_FILE,
  PLUGIN_REQUIREMENT_FILE,
  findBundledPluginComposition,
  inspectBundledPluginComposition,
  readPluginCompositionRequirement,
  verifyBundledArtifactBinding
};
