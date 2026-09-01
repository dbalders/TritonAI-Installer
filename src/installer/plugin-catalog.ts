const fs = require("fs");
const path = require("path");
const { assertCanonicalPluginRepository } = require("./plugin-provenance");

const CATALOG_KIND = "tritonai-managed-plugin-catalog";
const CATALOG_VERSION = 1;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

function readManagedPluginCatalog(file: string) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Managed plugin catalog is not valid JSON: ${error.message}`);
  }
  return validateManagedPluginCatalog(value);
}

function validateManagedPluginCatalog(value) {
  assertRecord(value, "Managed plugin catalog");
  assertOnlyKeys(value, ["version", "kind", "source", "packages"], "Managed plugin catalog");
  if (value.version !== CATALOG_VERSION || value.kind !== CATALOG_KIND) {
    throw new Error("Managed plugin catalog has an unsupported version or kind.");
  }

  assertRecord(value.source, "Managed plugin catalog source");
  assertOnlyKeys(value.source, ["repository", "ref", "commit"], "Managed plugin catalog source");
  assertCanonicalPluginRepository(value.source.repository, "Managed plugin catalog source.repository");
  if (!isSafeRef(value.source.ref)) throw new Error("Managed plugin catalog source.ref is unsafe.");
  if (typeof value.source.commit !== "string" || !COMMIT.test(value.source.commit)) {
    throw new Error("Managed plugin catalog source.commit must be a full lowercase Git commit SHA.");
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error("Managed plugin catalog must approve at least one package.");
  }

  let previousId = "";
  for (const plugin of value.packages) {
    assertRecord(plugin, "Managed plugin catalog package");
    assertOnlyKeys(
      plugin,
      [
        "pluginId",
        "version",
        "digest",
        "manifestDigest"
      ],
      "Managed plugin catalog package"
    );
    if (typeof plugin.pluginId !== "string"
      || !ID.test(plugin.pluginId)
      || plugin.pluginId <= previousId) {
      throw new Error("Managed plugin catalog packages must have unique, sorted stable ids.");
    }
    previousId = plugin.pluginId;
    if (typeof plugin.version !== "string" || !STABLE_SEMVER.test(plugin.version)) {
      throw new Error(`Managed plugin catalog package ${plugin.pluginId} has an invalid version.`);
    }
    for (const field of ["digest", "manifestDigest"]) {
      if (typeof plugin[field] !== "string" || !SHA256.test(plugin[field])) {
        throw new Error(`Managed plugin catalog package ${plugin.pluginId} has an invalid ${field}.`);
      }
    }
  }
  return value;
}

function assertCatalogComposition(catalog, composition) {
  const approved = validateManagedPluginCatalog(catalog);
  if (composition.source.repository !== approved.source.repository
    || composition.source.ref !== approved.source.ref
    || composition.source.commit !== approved.source.commit) {
    throw new Error("Prepared managed plugins do not match the approved catalog source.");
  }
  if (composition.packages.length !== approved.packages.length) {
    throw new Error("Prepared managed plugin count does not match the approved catalog.");
  }
  for (let index = 0; index < approved.packages.length; index += 1) {
    const expected = approved.packages[index];
    const actual = composition.packages[index];
    const manifest = actual?.files?.find((file) => file.path === ".tritonai-plugin/plugin.json");
    if (!actual
      || actual.id !== expected.pluginId
      || actual.version !== expected.version
      || actual.digest !== expected.digest
      || manifest?.sha256 !== expected.manifestDigest) {
      throw new Error(
        `Prepared managed plugin ${expected.pluginId} does not match the approved catalog digests.`
      );
    }
  }
  return composition;
}

function isSafeRef(value) {
  return typeof value === "string"
    && SAFE_REF.test(value)
    && !value.includes("..")
    && !value.includes("@{")
    && !value.includes("//")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.endsWith(".lock");
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
  CATALOG_KIND,
  CATALOG_VERSION,
  assertCatalogComposition,
  readManagedPluginCatalog,
  validateManagedPluginCatalog
};
