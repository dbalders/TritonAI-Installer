import { contextBridge, ipcRenderer } from "electron";

const installerApi: InstallerApi = {
  getPlatform: () => ipcRenderer.invoke("installer:get-platform"),
  openDocs: (url) => ipcRenderer.invoke("installer:open-docs", url),
  startInstall: (payload) => ipcRenderer.invoke("installer:start", payload),
  finishInstall: (payload) => ipcRenderer.invoke("installer:finish", payload),
  getSupportInfo: () => ipcRenderer.invoke("installer:get-support-info"),
  copySupportReport: () => ipcRenderer.invoke("installer:copy-support-report"),
  showLogs: () => ipcRenderer.invoke("installer:show-logs"),
  onLog: (callback) => {
    ipcRenderer.removeAllListeners("installer:log");
    ipcRenderer.on("installer:log", (_event, message) => callback(String(message)));
  }
};

contextBridge.exposeInMainWorld("ucsdInstaller", installerApi);
