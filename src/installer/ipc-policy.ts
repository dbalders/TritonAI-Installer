import { fileURLToPath, pathToFileURL } from "node:url";
import type { IpcMainInvokeEvent, WebContents } from "electron";

export function assertInstallerSender(
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
  contents: WebContents | null | undefined,
  rendererFile: string
) {
  if (!contents || contents.isDestroyed() || event.sender !== contents
    || !event.senderFrame || event.senderFrame !== contents.mainFrame
    || !matchesRendererFile(event.senderFrame.url, rendererFile)) {
    throw new Error("Installer request did not originate from its main window.");
  }
}

function matchesRendererFile(value: string, rendererFile: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.search || url.hash) return false;
    // Chromium leaves ~ literal in Windows short paths while Node encodes it.
    // Round-trip both through Node's file URL rules before comparing identity.
    return pathToFileURL(fileURLToPath(url)).href === pathToFileURL(rendererFile).href;
  } catch {
    return false;
  }
}

export function documentationUrl(configured: unknown): string {
  if (typeof configured !== "string" || !configured) {
    throw new Error("No TritonAI access documentation URL is configured for this build.");
  }
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("TritonAI documentation must use an HTTPS URL without credentials.");
  }
  return url.href;
}

export function installedLaunchTarget(tool: unknown, installed: DesktopApps | null): string {
  if (tool !== "t3code" || !installed) {
    throw new Error("Complete a successful installation before opening TritonAI Harness.");
  }
  const target = installed.t3codeShortcut || installed.t3code;
  if (!target) throw new Error("The installed TritonAI Harness launch path could not be found.");
  return target;
}
