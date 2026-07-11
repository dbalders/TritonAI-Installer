const assert = require("assert");
const fs = require("fs");
const path = require("path");

const progressScript = fs.readFileSync(
  path.resolve(__dirname, "..", "src", "renderer", "install-progress.js"),
  "utf8"
);
const calculateProgress = new Function(`${progressScript}\nreturn getInstallProgress;`)();

assert.deepStrictEqual(
  [-1, 0, 1, 2, 3].map((detailIndex) => calculateProgress("darwin", "prepare", detailIndex)),
  [1, 2, 3, 4, 5]
);
assert.deepStrictEqual(
  [-1, 0, 1, 2].map((detailIndex) => calculateProgress("darwin", "connect", detailIndex)),
  [6, 7, 8, 9]
);
assert.deepStrictEqual(
  [-1, 0, 1, 2, 3].map((detailIndex) => calculateProgress("darwin", "tools", detailIndex)),
  [10, 10, 10, 10, 10]
);
assert.deepStrictEqual(
  [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((detailIndex) => calculateProgress("darwin", "shortcut", detailIndex)),
  [11, 12, 15, 22, 67, 75, 78, 82, 97]
);
assert.deepStrictEqual(
  [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((detailIndex) => calculateProgress("win32", "shortcut", detailIndex)),
  [11, 25, 25, 30, 82, 90, 92, 94, 97]
);
assert.deepStrictEqual(
  [-1, 0, 1].map((detailIndex) => calculateProgress("darwin", "verify", detailIndex)),
  [98, 99, 99]
);
assert.strictEqual(calculateProgress("darwin", "shortcut", 99), 97);
assert.strictEqual(calculateProgress("darwin", "unknown", 0), 0);

console.log("Renderer progress milestone tests passed.");
