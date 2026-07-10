const path = require("path");

function defaultAppRoot(currentDir: string): string {
  const candidate = path.resolve(currentDir, "..", "..");
  return path.basename(candidate) === "dist" ? path.dirname(candidate) : candidate;
}

module.exports = { defaultAppRoot };
