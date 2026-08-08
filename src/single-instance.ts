import type { App } from "electron";

type SingleInstanceApp = Pick<App, "requestSingleInstanceLock" | "on" | "quit">;

export function acquireSingleInstance(
  app: SingleInstanceApp,
  onSecondInstance: () => void
): boolean {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return false;
  }

  app.on("second-instance", onSecondInstance);
  return true;
}
