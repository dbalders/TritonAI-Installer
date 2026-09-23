import * as fs from "node:fs";
import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { assertInstallerSender, documentationUrl, installedLaunchTarget } from "./installer/ipc-policy";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { InstallLifecycle } from "./install-lifecycle";
import { acquireSingleInstance } from "./single-instance";
import {
  assertInstallMutationAllowed,
  readPackagedBootSmokeRequest,
  writePackagedBootSmokeMarker,
  writePackagedBootSmokeFailure
} from "./packaged-boot-smoke";
const { runInstall } = require("./installer/runner");
const { getInstallPreview } = require("./installer/tool-manifest");
const { UCSD } = require("./installer/constants");
const { findExistingCredentials } = require("./installer/existing-api-key");
const { checkTritonAiConnection } = require("./installer/tritonai-connection");
const {
  checkAndAssignCredentials,
  credentialValues
} = require("./installer/credentials");
const { readPluginCompositionRequirement } = require("./installer/plugins");

const INSTALLER_DMG_VOLUME_TITLE = "TritonAI Installer";
const PACKAGED_BOOT_HEALTH_MS = 5_000;
const PACKAGED_BOOT_TIMEOUT_MS = 30_000;
const packagedBootSmoke = readPackagedBootSmokeRequest(process.argv, os.tmpdir());
let installCompleted = false;
let installedDesktopApps: DesktopApps | null = null;
let lastDiagnostics: DiagnosticsInfo | null = null;
let mainWindow: BrowserWindow | null = null;
let smokeWindowReady = false;
let smokeRendererReady = false;
let smokeFinished = false;
let smokeHealthStarted = false;
let installCloseNoticeVisible = false;
const installLifecycle = new InstallLifecycle();
const credentialSessions = new Map<string, TritonAiCredentials>();

function storeCredentialSession(credentials): string {
  if (credentialSessions.size >= 8) credentialSessions.clear();
  const handle = randomUUID();
  credentialSessions.set(handle, credentials);
  return handle;
}

if (packagedBootSmoke) {
  fs.mkdirSync(packagedBootSmoke.userDataPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", packagedBootSmoke.userDataPath);
  setTimeout(() => failPackagedBootSmoke(new Error("Timed out waiting for a healthy Installer window.")), PACKAGED_BOOT_TIMEOUT_MS);
  process.on("uncaughtException", failPackagedBootSmoke);
  process.on("unhandledRejection", (reason) => failPackagedBootSmoke(reason));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 580,
    height: 500,
    minWidth: 540,
    minHeight: 390,
    title: "TritonAI Installer",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  if (packagedBootSmoke) {
    mainWindow.once("ready-to-show", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        failPackagedBootSmoke(new Error("Installer window was destroyed before it became visible."));
        return;
      }
      mainWindow.show();
      smokeWindowReady = mainWindow.isVisible();
      maybeCompletePackagedBootSmoke();
    });
    mainWindow.once("unresponsive", () => failPackagedBootSmoke(new Error("Installer window became unresponsive.")));
    mainWindow.webContents.once("did-fail-load", (_event, code, description) => {
      failPackagedBootSmoke(new Error(`Installer renderer failed to load (${code}): ${description}`));
    });
    mainWindow.webContents.once("render-process-gone", (_event, details) => {
      failPackagedBootSmoke(new Error(`Installer renderer exited unexpectedly: ${details.reason}`));
    });
  }

  mainWindow.on("close", (event) => {
    if (!installLifecycle.shouldBlockExit()) return;
    event.preventDefault();
    showInstallInProgressNotice();
  });

  void mainWindow.loadFile(path.join(__dirname, "renderer", "index.html")).catch(failPackagedBootSmoke);
}

const ownsSingleInstanceLock = acquireSingleInstance(app, () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (installLifecycle.isInstallInProgress()) showInstallInProgressNotice();
});

if (ownsSingleInstanceLock) app.whenReady().then(() => {
  handleInstallerIpc("installer:get-platform", async () => {
    if (packagedBootSmoke) {
      return {
        platform: process.platform,
        home: "<packaged-boot-smoke>",
        version: app.getVersion(),
        preview: getInstallPreview(process.platform),
        managedConfig: { apiDocsUrl: UCSD.apiDocsUrl },
        existingCredentials: null
      };
    }
    const existing = await findExistingCredentials({
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
      existingCredentials: existing
        ? {
            source: existing.source,
            apiKeys: credentialValues(existing.credentials)
          }
        : null
    };
  });

  handleInstallerIpc("installer:renderer-ready", async () => {
    if (!packagedBootSmoke) return;
    smokeRendererReady = true;
    maybeCompletePackagedBootSmoke();
  });

  handleInstallerIpc("installer:open-docs", async () => {
    await shell.openExternal(documentationUrl(UCSD.apiDocsUrl));
  });

  handleInstallerIpc("installer:check-access", async (_event, payload: CredentialCheckPayload = {}) => {
    const result = await checkAndAssignCredentials({
      apiKeys: payload?.apiKeys,
      checkConnection: checkTritonAiConnection,
      baseUrl: UCSD.baseUrl,
      timeoutMs: 10_000
    });
    return {
      credentialHandle: storeCredentialSession(result.credentials),
      access: result.access,
      assignments: result.assignments
    };
  });

  handleInstallerIpc("installer:start", async (event, payload: InstallPayload) => {
    assertInstallMutationAllowed(packagedBootSmoke);
    installLifecycle.beginInstall();
    installCompleted = false;
    installedDesktopApps = null;
    lastDiagnostics = null;
    try {
      const credentials = credentialSessions.get(payload?.credentialHandle);
      if (!credentials) {
        throw new Error("Check TritonAI access before starting the installation.");
      }
      const result = await runInstall({ credentials }, {
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
        emit: (message) => {
          if (event.sender.isDestroyed()) return;
          try {
            event.sender.send("installer:log", message);
          } catch (error) {
            console.error(`Could not deliver Installer progress to the renderer: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
        onDiagnostics: (diagnostics) => {
          lastDiagnostics = diagnostics;
        }
      });
      installedDesktopApps = { ...result.desktopApps };
      credentialSessions.clear();
      installCompleted = true;
      lastDiagnostics = result.diagnostics || lastDiagnostics;
      return result;
    } catch (error) {
      lastDiagnostics = error.diagnostics || lastDiagnostics;
      throw error;
    } finally {
      installLifecycle.endInstall();
    }
  });

  handleInstallerIpc("installer:get-support-info", async () => lastDiagnostics);

  handleInstallerIpc("installer:copy-support-report", async () => {
    if (!lastDiagnostics || !lastDiagnostics.supportReportFile) {
      throw new Error("No installer support report is available yet.");
    }

    const content = fs.readFileSync(lastDiagnostics.supportReportFile, "utf8");
    clipboard.writeText(content);
    return lastDiagnostics;
  });

  handleInstallerIpc("installer:show-logs", async () => {
    if (!lastDiagnostics || !lastDiagnostics.logsDir) {
      throw new Error("No installer logs folder is available yet.");
    }

    if (lastDiagnostics.supportReportFile && fs.existsSync(lastDiagnostics.supportReportFile)) {
      shell.showItemInFolder(lastDiagnostics.supportReportFile);
      return lastDiagnostics;
    }

    const error = await shell.openPath(lastDiagnostics.logsDir);
    if (error) throw new Error(error);
    return lastDiagnostics;
  });

  handleInstallerIpc("installer:finish", async (event, payload: FinishPayload = {}) => {
    if (installLifecycle.isInstallInProgress()) {
      throw new Error("Wait for installation to finish before closing the Installer.");
    }
    if (!installLifecycle.requestFinish()) return;
    try {
      const openTool = payload?.openTool;
      if (openTool && ["darwin", "win32"].includes(process.platform)) {
        const target = installedLaunchTarget(openTool, installedDesktopApps);
        const error = await shell.openPath(target);
        if (error) throw new Error(error);
      }

      const window = BrowserWindow.fromWebContents(event.sender);
      if (window && !window.isDestroyed()) window.close();
      completeFinish();
    } catch (error) {
      installLifecycle.cancelFinish();
      throw error;
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

function handleInstallerIpc(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      assertInstallerSender(event, mainWindow?.webContents, path.join(__dirname, "renderer", "index.html"));
      return await handler(event, ...args);
    } catch (error) {
      if (packagedBootSmoke) {
        failPackagedBootSmoke(new Error(`${channel}: ${error instanceof Error ? error.message : String(error)}; renderer=${event.senderFrame?.url}`));
      }
      throw error;
    }
  });
}

function finishInstaller() {
  if (!installLifecycle.requestFinish()) return;
  completeFinish();
}

function completeFinish() {
  const mountedVolume = getMountedInstallerVolume();
  if (mountedVolume) {
    scheduleVolumeEject(mountedVolume);
  }

  setTimeout(() => app.quit(), 100);
}

function showInstallInProgressNotice() {
  if (installCloseNoticeVisible) return;
  installCloseNoticeVisible = true;
  const options = {
    type: "info" as const,
    buttons: ["Keep Installing"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: "TritonAI installation in progress",
    message: "TritonAI is still being installed.",
    detail: "Keep this window open until setup finishes or reports a safe retry. Force-quitting or shutting down can interrupt system installers."
  };
  const notice = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options);
  void notice.catch((error) => console.error("Could not show installation notice:", error)).finally(() => {
    installCloseNoticeVisible = false;
  });
}

function maybeCompletePackagedBootSmoke() {
  if (!packagedBootSmoke || smokeFinished || smokeHealthStarted || !smokeWindowReady || !smokeRendererReady) return;
  smokeHealthStarted = true;
  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.webContents.isCrashed()) {
      failPackagedBootSmoke(new Error("Installer window did not remain healthy and visible."));
      return;
    }
    writePackagedBootSmokeMarker(packagedBootSmoke, {
      schemaVersion: 1,
      productName: "TritonAI Installer",
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      healthyForMs: PACKAGED_BOOT_HEALTH_MS,
      readyAt: new Date().toISOString()
    });
    smokeFinished = true;
    app.exit(app.isPackaged ? 0 : 1);
  }, PACKAGED_BOOT_HEALTH_MS);
}

function failPackagedBootSmoke(reason: unknown) {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  if (!packagedBootSmoke) {
    console.error(error);
    return;
  }
  if (smokeFinished) return;
  smokeFinished = true;
  try {
    writePackagedBootSmokeFailure(packagedBootSmoke, error.message, {
      windowReady: smokeWindowReady, rendererReady: smokeRendererReady, healthStarted: smokeHealthStarted
    });
  } catch { /* Reporting must not prevent a failed exit. */ }
  console.error(`Packaged boot smoke test failed: ${error.message}`);
  app.exit(1);
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
  child.on("error", (error) => console.error("Could not schedule Installer volume eject:", error));
  child.unref();
}

app.on("window-all-closed", () => {
  if (process.platform === "darwin" && installCompleted) {
    finishInstaller();
    return;
  }

  app.quit();
});

app.on("before-quit", (event) => {
  if (!installLifecycle.shouldBlockExit()) return;
  event.preventDefault();
  showInstallInProgressNotice();
});
