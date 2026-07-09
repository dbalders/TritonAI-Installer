const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const localSourceOverride = process.env.UCSD_SKILLS_SOURCE;
const repo = process.env.UCSD_SKILLS_REPO || "https://github.com/dbalders/UCSD-Skills-Library.git";
const ref = process.env.UCSD_SKILLS_REF || "main";
const vendorDir = path.join(root, "vendor", "skills");
const sourceDirNames = [
  process.env.UCSD_SKILLS_SUBDIR,
  "skills",
  "tritonai"
].filter(Boolean);
const localSourceCandidates = [
  localSourceOverride,
  path.join(root, "..", "UCSD-Skills-Library"),
  path.join(root, "..", "..", "UCSD-Skills-Library")
].filter(Boolean);

function main() {
  const localSource = findLocalSkillsSource(localSourceCandidates);
  if (localSource) {
    const result = stageSkillsFromSource({
      sourceRoot: localSource,
      vendorDir,
      sourceInfo: getLocalSourceInfo(localSource)
    });
    console.log(`Prepared ${result.skills.length} UCSD skill${result.skills.length === 1 ? "" : "s"} from ${localSource}.`);
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ucsd-skills-vendor-"));
  try {
    const cloneDir = path.join(tempRoot, "repo");
    run("git", ["clone", "--depth", "1", "--branch", ref, repo, cloneDir]);
    const result = stageSkillsFromSource({
      sourceRoot: cloneDir,
      vendorDir,
      sourceInfo: {
        type: "git",
        repo,
        ref,
        commit: getGitValue(cloneDir, ["rev-parse", "HEAD"])
      }
    });

    console.log(`Prepared ${result.skills.length} UCSD skill${result.skills.length === 1 ? "" : "s"} from ${repo}#${ref} (${result.source.commit}).`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function findLocalSkillsSource(candidates) {
  return candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => findSkillsSourceDir(candidate));
}

function stageSkillsFromSource({ sourceRoot, vendorDir, sourceInfo }) {
  const skillsSource = findSkillsSourceDir(sourceRoot);
  if (!skillsSource) {
    throw new Error(`Skills source does not contain a packageable skills directory (${sourceDirNames.join(", ")}): ${sourceRoot}`);
  }

  const skillNames = findPackagedSkillNames(skillsSource);
  if (skillNames.length === 0) {
    throw new Error(`Skills source has no packageable skill folders with SKILL.md: ${sourceRoot}`);
  }

  fs.rmSync(vendorDir, { recursive: true, force: true });
  fs.mkdirSync(vendorDir, { recursive: true });
  for (const skillName of skillNames) {
    fs.cpSync(path.join(skillsSource, skillName), path.join(vendorDir, skillName), {
      recursive: true,
      force: true,
      filter: shouldCopySkillEntry
    });
  }

  const manifest = {
    source: sourceInfo,
    skills: skillNames
  };
  fs.writeFileSync(path.join(vendorDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { source: sourceInfo, skills: skillNames };
}

function findSkillsSourceDir(sourceRoot) {
  for (const dirName of sourceDirNames) {
    const candidate = path.join(sourceRoot, dirName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  return null;
}

function findPackagedSkillNames(skillsSource) {
  return fs.readdirSync(skillsSource, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(isPackagedSkillName)
    .filter((name) => fs.existsSync(path.join(skillsSource, name, "SKILL.md")))
    .sort();
}

function isPackagedSkillName(name) {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

function shouldCopySkillEntry(entry) {
  const basename = path.basename(entry);
  return basename !== ".DS_Store" && !entry.includes(`${path.sep}.git${path.sep}`) && !entry.endsWith(`${path.sep}.git`);
}

function getLocalSourceInfo(sourceRoot) {
  const commit = getGitValue(sourceRoot, ["rev-parse", "HEAD"]);
  const dirty = getGitValue(sourceRoot, ["status", "--porcelain"]) !== "";
  return {
    type: "local",
    path: sourceRoot,
    ...(commit ? { commit, dirty } : {})
  };
}

function getGitValue(cwd, args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch (_error) {
    return "";
  }
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit"
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  findPackagedSkillNames,
  findSkillsSourceDir,
  findLocalSkillsSource,
  isPackagedSkillName,
  stageSkillsFromSource
};
