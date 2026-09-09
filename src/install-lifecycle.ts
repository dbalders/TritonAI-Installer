class InstallLifecycle {
  private installInProgress = false;
  private finishRequested = false;

  beginInstall() {
    if (this.finishRequested) {
      throw new Error("The Installer is closing. Reopen it to start another installation.");
    }
    if (this.installInProgress) {
      throw new Error("A TritonAI installation is already running.");
    }
    this.installInProgress = true;
  }

  endInstall() {
    this.installInProgress = false;
  }

  requestFinish() {
    if (this.installInProgress || this.finishRequested) return false;
    this.finishRequested = true;
    return true;
  }

  cancelFinish() {
    this.finishRequested = false;
  }

  shouldBlockExit() {
    return this.installInProgress;
  }

  isInstallInProgress() {
    return this.installInProgress;
  }
}

export { InstallLifecycle };
