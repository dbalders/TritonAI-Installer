import { spawn as spawnChildProcess } from "node:child_process";

interface ExternalBrowserRuntime {
  platform?: NodeJS.Platform;
  openExternal: (url: string) => Promise<void>;
  spawn?: typeof spawnChildProcess;
}

async function openUrlInDefaultBrowser(url: string, runtime: ExternalBrowserRuntime): Promise<void> {
  if (!url) {
    throw new Error("No TritonAI access documentation URL is configured for this build.");
  }

  const normalizedUrl = new URL(url).toString();
  const platform = runtime.platform || process.platform;

  try {
    await runtime.openExternal(normalizedUrl);
    return;
  } catch (error) {
    if (platform !== "win32") {
      throw error;
    }
  }

  await openWithWindowsExplorer(normalizedUrl, runtime.spawn || spawnChildProcess);
}

function openWithWindowsExplorer(url: string, spawn: typeof spawnChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("explorer.exe", [url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });

    const onError = (error: Error) => {
      child.removeListener("spawn", onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      child.removeListener("error", onError);
      child.unref();
      resolve();
    };

    child.once("error", onError);
    child.once("spawn", onSpawn);
  });
}

module.exports = {
  openUrlInDefaultBrowser
};
