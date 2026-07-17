const path = require("path");

const CANONICAL_PLUGIN_REPOSITORY = "dbalders/TritonAI-Plugins";
const CANONICAL_PLUGIN_REPOSITORY_URL = "https://github.com/dbalders/TritonAI-Plugins.git";

function assertCanonicalPluginRepository(repository, label = "TritonAI plugin source") {
  const parsed = parseGitHubRepository(repository);
  const canonical = parsed
    && parsed.host === "github.com"
    && parsed.owner.toLowerCase() === "dbalders"
    && parsed.repository.toLowerCase() === "tritonai-plugins";
  if (!canonical) {
    throw new Error(
      `${label} must identify github.com/${CANONICAL_PLUGIN_REPOSITORY}; `
      + `${sanitizeRepositoryUrl(repository)} is not accepted as managed plugin provenance.`
    );
  }
  return CANONICAL_PLUGIN_REPOSITORY;
}

function parseGitHubRepository(value) {
  const raw = String(value || "").trim();
  if (!raw || isLocalRepository(raw)) return null;

  if (!raw.includes("://")) {
    const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!scp || /[?#]/.test(scp[2])) return null;
    return parseCanonicalPath(scp[1], scp[2]);
  }

  try {
    const parsed = new URL(raw);
    if (!["https:", "ssh:"].includes(parsed.protocol)) return null;
    if (parsed.port || parsed.search || parsed.hash || parsed.pathname.includes("%")) return null;
    return parseCanonicalPath(parsed.hostname, parsed.pathname);
  } catch (_error) {
    return null;
  }
}

function parseCanonicalPath(host, repositoryPath) {
  const parts = String(repositoryPath).split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repository = parts[1].replace(/\.git$/i, "");
  return owner && repository
    ? { host: String(host).toLowerCase(), owner, repository }
    : null;
}

function sanitizeRepositoryUrl(value) {
  const raw = String(value || "").trim();
  if (isLocalRepository(raw)) return "local-repository";

  if (!raw.includes("://")) {
    const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) return `${scp[1]}:${scp[2].replace(/[?#].*$/, "")}`;
  }

  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch (_error) {
    return "invalid-repository-url";
  }
}

function isLocalRepository(value) {
  return path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || /^file:/i.test(value);
}

module.exports = {
  CANONICAL_PLUGIN_REPOSITORY,
  CANONICAL_PLUGIN_REPOSITORY_URL,
  assertCanonicalPluginRepository,
  parseGitHubRepository,
  sanitizeRepositoryUrl
};
