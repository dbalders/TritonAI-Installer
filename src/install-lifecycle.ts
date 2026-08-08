class InstallLifecycle {
  private installInProgress = false;
  private finishRequested = false;

  beginInstall() {
    if (this.installInProgress) {
      throw new Error("A TritonAI installation is already running.");
    }
    this.installInProgress = true;
  }

  endInstall() {
    this.installInProgress = false;
  }

  requestFinish() {
    if (this.finishRequested) return false;
    this.finishRequested = true;
    return true;
  }

  shouldBlockExit() {
    return this.installInProgress && !this.finishRequested;
  }

  isInstallInProgress() {
    return this.installInProgress;
  }
}

export { InstallLifecycle };
