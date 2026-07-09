const fs = require("fs");
const path = require("path");

function installBundledSkills({ paths, emit = () => {}, resourcesPath, appRoot } = {}) {
  const source = findBundledSkillsDir({ resourcesPath, appRoot });
  fs.mkdirSync(paths.skillsDir, { recursive: true });

  if (!source) {
    emit("No bundled UCSD skills found; TritonAI Harness will use any previously installed UCSD skills.");
    return { installed: 0, source: null };
  }

  fs.rmSync(paths.skillsDir, { recursive: true, force: true });
  fs.mkdirSync(paths.skillsDir, { recursive: true });
  fs.cpSync(source, paths.skillsDir, {
    recursive: true,
    force: true,
    filter: (entry) => !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`)
  });

  const installed = listSkillDirs(paths.skillsDir).length;
  emit(`Installed ${installed} bundled UCSD skill${installed === 1 ? "" : "s"} for TritonAI Harness.`);
  return { installed, source };
}

function findBundledSkillsDir(options = {}) {
  const candidates = bundleBaseCandidates(options)
    .map((base) => path.join(base, "vendor", "skills"));

  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) || null;
}

function bundleBaseCandidates(options = {}) {
  const explicitResourcesPath = options.resourcesPath === undefined ? process.resourcesPath : options.resourcesPath;
  const appRoot = options.appRoot || path.resolve(__dirname, "..", "..");

  return [
    explicitResourcesPath && path.join(explicitResourcesPath, "app"),
    explicitResourcesPath,
    appRoot
  ].filter(Boolean);
}

function listSkillDirs(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(skillsDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "SKILL.md")))
    .sort();
}

module.exports = {
  installBundledSkills,
  findBundledSkillsDir,
  listSkillDirs
};
