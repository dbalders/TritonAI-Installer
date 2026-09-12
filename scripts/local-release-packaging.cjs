const path = require('node:path');
const { createRequire } = require('node:module');

// Resolve through the package that actually declares electron-builder so pnpm's
// isolated dependency layout works without installing the Installer workspace.
function packagingLibrary({ harnessRoot, installerRoot }) {
  if (harnessRoot) {
    const desktopRequire = createRequire(path.join(harnessRoot, 'apps/desktop/package.json'));
    const builderRequire = createRequire(desktopRequire.resolve('electron-builder/package.json'));
    return builderRequire.resolve('app-builder-lib/package.json');
  }
  return createRequire(path.join(installerRoot, 'package.json')).resolve('app-builder-lib/package.json');
}
module.exports = { packagingLibrary };
