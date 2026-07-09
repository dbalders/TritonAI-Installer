const fs = require("fs");
const crypto = require("crypto");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { validateManagedSkillsManifest } = require("../src/installer/skill-manifest");

const appPath = process.argv[2];

if (!appPath) {
  throw new Error("Usage: node scripts/verify-macos-bundled-resources.js /path/to/App.app");
}

const t3VendorDir = path.join(appPath, "Contents", "Resources", "vendor", "t3code-desktop", "mac-arm64");
const codexVendorDir = path.join(appPath, "Contents", "Resources", "vendor", "codex-cli", "mac-arm64");
const skillsVendorDir = path.join(appPath, "Contents", "Resources", "vendor", "skills");
const checks = [
  {
    name: "TritonAI Harness Desktop",
    file: findFirstFile(t3VendorDir, /^TritonAI-Harness-.+\.dmg$/),
    manifest: path.join(t3VendorDir, "latest-mac.yml"),
    appNames: ["TritonAI Harness.app"]
  }
];

for (const check of checks) {
  verifyBundledFile(check);
}
verifyBundledSkills(skillsVendorDir);
verifyBundledCodexCli(codexVendorDir);

console.log("Bundled macOS resources verified.");

function verifyBundledFile({ name, file, manifest, appNames = [] }) {
  if (!file) {
    throw new Error(`${name} bundled file is missing under ${t3VendorDir}`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`${name} bundled file is missing: ${file}`);
  }

  if (!fs.existsSync(manifest)) {
    throw new Error(`${name} manifest is missing: ${manifest}`);
  }

  verifyManifestReferencesFile(manifest, path.basename(file));
  verifyManifestFileDigest(manifest, file);
  run("hdiutil", ["verify", file]);

  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-bundled-resource-"));
  try {
    run("hdiutil", ["attach", file, "-nobrowse", "-readonly", "-mountpoint", mountPoint]);
    if (appNames.length > 0 && !appNames.some((appName) => findApp(mountPoint, appName))) {
      throw new Error(`${name} image does not contain an expected app bundle (${appNames.join(", ")}): ${file}`);
    }
  } finally {
    spawnSync("hdiutil", ["detach", mountPoint], { stdio: "inherit" });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function verifyManifestReferencesFile(manifest, fileName) {
  const text = fs.readFileSync(manifest, "utf8");
  if (!text.includes(fileName)) {
    throw new Error(`${manifest} does not reference ${fileName}`);
  }
}

function verifyManifestFileDigest(manifest, file) {
  const expected = parseLatestYml(fs.readFileSync(manifest, "utf8")).files[path.basename(file)];
  if (!expected) {
    throw new Error(`${manifest} does not include metadata for ${path.basename(file)}`);
  }

  const stat = fs.statSync(file);
  if (Number.isFinite(expected.size) && stat.size !== expected.size) {
    throw new Error(`Size mismatch for ${path.basename(file)}: expected ${expected.size}, got ${stat.size}`);
  }

  const actual = crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
  if (actual !== expected.sha512) {
    throw new Error(`SHA-512 mismatch for ${path.basename(file)}`);
  }
}

function parseLatestYml(text) {
  const result = { files: {} };
  let currentFile = null;

  for (const line of text.split(/\r?\n/)) {
    const urlMatch = line.match(/^\s*-\s+url:\s+(.+)\s*$/);
    if (urlMatch) {
      currentFile = cleanYamlValue(urlMatch[1]);
      result.files[currentFile] = {};
      continue;
    }

    const propertyMatch = line.match(/^\s+(sha512|size):\s+(.+)\s*$/);
    if (currentFile && propertyMatch) {
      const [, key, rawValue] = propertyMatch;
      result.files[currentFile][key] = key === "size"
        ? Number(cleanYamlValue(rawValue))
        : cleanYamlValue(rawValue);
    }
  }

  return result;
}

function cleanYamlValue(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function verifyBundledSkills(skillsDir) {
  if (!fs.existsSync(skillsDir)) {
    throw new Error(`Bundled secure skills directory is missing: ${skillsDir}`);
  }

  const skills = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (skills.length === 0) {
    throw new Error(`Bundled secure skills directory has no skill folders: ${skillsDir}`);
  }
  for (const name of skills) {
    const skillFile = path.join(skillsDir, name, "SKILL.md");
    if (!fs.existsSync(skillFile) || !fs.statSync(skillFile).isFile()) {
      throw new Error(`Bundled secure skill is missing SKILL.md: ${name}`);
    }
  }

  const manifestPath = path.join(skillsDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundled secure skills manifest is missing: ${manifestPath}`);
  }
  const manifest = validateManagedSkillsManifest(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    "Bundled secure skills manifest"
  );
  if (JSON.stringify(manifest.skills) !== JSON.stringify(skills)) {
    throw new Error("Bundled secure skills manifest does not match packaged skill directories.");
  }
}

function verifyBundledCodexCli(codexDir) {
  if (!fs.existsSync(codexDir)) {
    throw new Error(`Bundled Codex CLI directory is missing: ${codexDir}`);
  }

  const codexBin = path.join(codexDir, "bin", "codex");
  const codexJs = path.join(codexDir, "lib", "node_modules", "@openai", "codex", "bin", "codex.js");
  const nativeDir = path.join(codexDir, "lib", "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-darwin-arm64");
  for (const file of [codexBin, codexJs]) {
    if (!fs.existsSync(file)) {
      throw new Error(`Bundled Codex CLI file is missing: ${file}`);
    }
  }
  if (!fs.existsSync(nativeDir) || !fs.statSync(nativeDir).isDirectory()) {
    throw new Error(`Bundled Codex CLI native package is missing: ${nativeDir}`);
  }
}

function findFirstFile(dir, pattern) {
  if (!fs.existsSync(dir)) return null;
  const entry = fs.readdirSync(dir).find((name) => pattern.test(name));
  return entry ? path.join(dir, entry) : null;
}

function findApp(rootDir, appName) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const direct = entries.find((entry) => entry.isDirectory() && entry.name === appName);
  if (direct) return path.join(rootDir, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.endsWith(".app")) continue;
    const nested = findApp(path.join(rootDir, entry.name), appName);
    if (nested) return nested;
  }

  return null;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}
