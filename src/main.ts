import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { app, BrowserWindow, clipboard, ipcMain, shell } from "electron";
const { runInstall } = require("./installer/runner");
const { getInstallPreview } = require("./installer/tool-manifest");
const { UCSD } = require("./installer/constants");
const { findExistingApiKey } = require("./installer/existing-api-key");
const { readPluginCompositionRequirement } = require("./installer/plugins");
const { openUrlInDefaultBrowser } = require("./external-browser");

const INSTALLER_DMG_VOLUME_TITLE = "Double-click to Install";
let installCompleted = false;
let finishRequested = false;
let lastDiagnostics: DiagnosticsInfo | null = null;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 580,
    height: 390,
    minWidth: 540,
    minHeight: 360,
    title: "TritonAI Installer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("installer:get-platform", async () => {
    const existingApiKey = await findExistingApiKey({
      homeDir: app.getPath("home"),
      platform: process.platform
    });

    return {
      platform: process.platform,
      home: app.getPath("home"),
      version: app.getVersion(),
      preview: getInstallPreview(process.platform),
      managedConfig: {
        apiDocsUrl: UCSD.apiDocsUrl
      },
      existingApiKey
    };
  });

  ipcMain.handle("installer:open-docs", async (_event, url: string) => {
    await openUrlInDefaultBrowser(url, {
      platform: process.platform,
      openExternal: (target) => shell.openExternal(target)
    });
  });

  ipcMain.handle("installer:start", async (event, payload: InstallPayload) => {
    installCompleted = false;
    try {
      const result = await runInstall(payload, {
        platform: process.platform,
        arch: process.arch,
        homeDir: app.getPath("home"),
        resourcesPath: process.resourcesPath,
        appRoot: app.getAppPath(),
        packaged: app.isPackaged,
        requirePluginComposition: readPluginCompositionRequirement({
          resourcesPath: process.resourcesPath,
          appRoot: app.getAppPath(),
          required: app.isPackaged
        }),
        installerVersion: app.getVersion(),
        emit: (message) => event.sender.send("installer:log", message),
        onDiagnostics: (diagnostics) => {
          lastDiagnostics = diagnostics;
        }
      });
      installCompleted = true;
      lastDiagnostics = result.diagnostics || lastDiagnostics;
      return result;
    } catch (error) {
      lastDiagnostics = error.diagnostics || lastDiagnostics;
      throw error;
    }
  });

  ipcMain.handle("installer:get-support-info", async () => lastDiagnostics);

  ipcMain.handle("installer:copy-support-report", async () => {
    if (!lastDiagnostics || !lastDiagnostics.supportReportFile) {
      throw new Error("No installer support report is available yet.");
    }

    const content = fs.readFileSync(lastDiagnostics.supportReportFile, "utf8");
    clipboard.writeText(content);
    return lastDiagnostics;
  });

  ipcMain.handle("installer:show-logs", async () => {
    if (!lastDiagnostics || !lastDiagnostics.logsDir) {
      throw new Error("No installer logs folder is available yet.");
    }

    if (lastDiagnostics.supportReportFile && fs.existsSync(lastDiagnostics.supportReportFile)) {
      shell.showItemInFolder(lastDiagnostics.supportReportFile);
      return lastDiagnostics;
    }

    await shell.openPath(lastDiagnostics.logsDir);
    return lastDiagnostics;
  });

  ipcMain.handle("installer:finish", async (event, payload: FinishPayload = {}) => {
    const openTool = payload.openTool;
    if (openTool && ["darwin", "win32"].includes(process.platform)) {
      const target = getLaunchTarget(openTool, payload.desktopApps || {}, app.getPath("home"));
      if (!target) {
        throw new Error(`The ${openTool} app is installed, but its launch path could not be found.`);
      }

      const error = await shell.openPath(target);
      if (error) {
        throw new Error(error);
      }
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (window && !window.isDestroyed()) {
      window.close();
    }
    finishInstaller();
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function getLaunchTarget(toolId: string, desktopApps: DesktopApps, _homeDir: string): string | null {
  if (toolId === "t3code") {
    return process.platform === "win32"
      ? desktopApps.t3codeShortcut || desktopApps.t3code
      : desktopApps.t3codeShortcut || desktopApps.t3code || "/Applications/TritonAI Harness.app";
  }

  return null;
}

function finishInstaller() {
  if (finishRequested) return;
  finishRequested = true;

  const mountedVolume = getMountedInstallerVolume();
  if (mountedVolume) {
    scheduleVolumeEject(mountedVolume);
  }

  setTimeout(() => app.quit(), 100);
}

function getMountedInstallerVolume() {
  if (process.platform !== "darwin" || !process.execPath.startsWith("/Volumes/")) {
    return null;
  }

  const [, , volumeName] = process.execPath.split(path.sep);
  if (!volumeName || !volumeName.startsWith(INSTALLER_DMG_VOLUME_TITLE)) {
    return null;
  }

  const volumePath = path.join("/Volumes", volumeName);
  const mountedInstallerApp = path.join(volumePath, "TritonAI Installer.app");
  return fs.existsSync(mountedInstallerApp) ? volumePath : null;
}

function scheduleVolumeEject(volumePath: string) {
  const child = spawn("/bin/sh", [
    "-c",
    "sleep 2; /usr/bin/hdiutil detach \"$1\" >/dev/null 2>&1 || /usr/bin/hdiutil detach -force \"$1\" >/dev/null 2>&1",
    "sh",
    volumePath
  ], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

app.on("window-all-closed", () => {
  if (process.platform === "darwin" && installCompleted) {
    finishInstaller();
    return;
  }

  app.quit();
});
