const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { NPM_POLICY } = require("../src/installer/npm-policy");
const { listTools, getCommands, CODEX_CLI } = require("../src/installer/tool-manifest");

const root = path.resolve(__dirname, "..", "..");
const cutoff = new Date(NPM_POLICY.cutoffDate);
interface LockPackageInfo {
  name?: string;
  version?: string;
}

const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")) as {
  packages?: Record<string, LockPackageInfo>;
};
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};
const failures: string[] = [];

for (const [name, spec] of Object.entries(packageJson.devDependencies || {})) {
  if (/^[~^]/.test(spec)) {
    failures.push(`${name} uses a floating version range: ${spec}`);
  }
}

for (const [lockPath, info] of Object.entries(packageLock.packages || {})) {
  if (!lockPath || !info.version) continue;
  const name = info.name || packageNameFromLockPath(lockPath);
  if (!name) continue;

  const publishedAt = getPublishedAt(name, info.version);
  if (!publishedAt) {
    failures.push(`${name}@${info.version} has no npm publish timestamp`);
    continue;
  }

  if (new Date(publishedAt) > cutoff) {
    failures.push(`${name}@${info.version} was published ${publishedAt}, after cutoff ${NPM_POLICY.cutoffDate}`);
  }
}

for (const tool of [...listTools(), CODEX_CLI]) {
  for (const [command, args] of getCommands(tool, "install")) {
    if (command !== "npm") continue;
    const cutoffIndex = args.indexOf("--before");
    if (cutoffIndex === -1 || args[cutoffIndex + 1] !== NPM_POLICY.cutoffDate) {
      failures.push(`${tool.name} npm install is missing --before ${NPM_POLICY.cutoffDate}`);
    }

    const packageSpec = args[args.length - 1];
    const parsed = parsePackageSpec(packageSpec);
    if (!parsed || !parsed.version) {
      failures.push(`${tool.name} npm install is not pinned to an exact package version: ${packageSpec}`);
      continue;
    }

    const publishedAt = getPublishedAt(parsed.name, parsed.version);
    if (!publishedAt || new Date(publishedAt) > cutoff) {
      failures.push(`${packageSpec} was published ${publishedAt || "unknown"}, after cutoff ${NPM_POLICY.cutoffDate}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`All locked npm packages were published on or before ${NPM_POLICY.cutoffDate}.`);

function packageNameFromLockPath(lockPath: string): string | null {
  const parts = lockPath.split("node_modules/");
  return parts[parts.length - 1] || null;
}

function getPublishedAt(name: string, version: string): string | null {
  const npm = npmInvocation();
  const raw = execFileSync(npm.command, [...npm.args, "view", `${name}@${version}`, "time", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    shell: npm.shell
  });
  const parsed = JSON.parse(raw);
  return parsed[version] || (parsed.time && parsed.time[version]);
}

function npmInvocation() {
  if (process.env.npm_execpath) {
    return {
      command: process.execPath,
      args: [process.env.npm_execpath],
      shell: false
    };
  }

  return {
    command: "npm",
    args: [],
    shell: process.platform === "win32"
  };
}

function parsePackageSpec(spec: string): { name: string; version: string } | null {
  const atIndex = spec.startsWith("@") ? spec.lastIndexOf("@") : spec.indexOf("@");
  if (atIndex <= 0) return null;
  return {
    name: spec.slice(0, atIndex),
    version: spec.slice(atIndex + 1)
  };
}
