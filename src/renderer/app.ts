const TRITONAI_APP_DISPLAY_NAME = "TritonAI Harness";

interface RendererState {
  apiKey: string;
  docsUrl: string;
  installPhase: string;
  installStepIndex: number;
  installResponse: InstallResponse | null;
  platform: string;
  events: Array<Record<string, any>>;
  detailProgress: Record<string, number>;
  progressValue: number;
  credentialError: string | null;
  prefilledApiKey: string;
  supportInfo: DiagnosticsInfo | null;
}

const state: RendererState = {
  apiKey: "",
  docsUrl: "",
  installPhase: "idle",
  installStepIndex: -1,
  installResponse: null,
  platform: "unknown",
  events: [],
  detailProgress: {},
  progressValue: 0,
  credentialError: null,
  prefilledApiKey: "",
  supportInfo: null
};

const installerApi: InstallerApi = window.ucsdInstaller || createPreviewInstallerApi();

const installSteps = [
  { id: "prepare", label: "Prepare this computer", match: ["creating", "checking installer prerequisites", "runtime", "node", "managed secure skill"] },
  { id: "connect", label: "Connect to TritonAI", match: ["saving", "access key", "environment", "tritonai connection", "connection verified"] },
  { id: "tools", label: "Automatic TritonAI setup", match: ["codex", "backend", "cli", "configuring", "routing", "defaults"] },
  { id: "shortcut", label: `Install ${TRITONAI_APP_DISPLAY_NAME}`, match: ["desktop", "shortcut", "applications", "launcher", "bundled image"] },
  { id: "verify", label: "Check everything works", match: ["recorded the installed tritonai installer version", "finished"] }
];

const installStepDetails = {
  prepare: [
    { id: "folders", label: "Create UC San Diego setup folders", match: ["creating ucsd", "setup folder"] },
    { id: "skills", label: "Install managed secure skills", match: ["managed secure skill"] },
    { id: "workspace", label: "Prepare the starter workspace", match: ["first-run tritonai workspace"] },
    { id: "runtime", label: "Check this computer and local runtime", match: ["checking installer prerequisites", "runtime", "node.js", "npm"] }
  ],
  connect: [
    { id: "request", label: "Check TritonAI access", match: ["checking tritonai connection"] },
    { id: "verified", label: "Confirm UC San Diego-managed access", match: ["connection verified"] },
    { id: "store", label: "Store access settings on this computer", match: ["saving", "access key", "environment", "shell environment"] }
  ],
  tools: [
    { id: "support", label: "Install managed Codex backend", match: ["installing managed codex", "found managed codex"] },
    { id: "verify", label: "Verify the managed Codex backend", match: ["verifying tritonai codex"] },
    { id: "routing", label: "Configure UC San Diego routing", match: ["configuring", "routing"] },
    { id: "defaults", label: `Apply ${TRITONAI_APP_DISPLAY_NAME} defaults`, match: ["defaults"] }
  ],
  shortcut: [
    { id: "package", label: `Prepare the ${TRITONAI_APP_DISPLAY_NAME} app package`, match: ["desktop app", "bundled image", "installer staged"] },
    { id: "image", label: "Verify the app package", match: ["verified tritonai harness installer image"] },
    { id: "mount", label: "Prepare the app for installation", match: ["mounted tritonai harness installer image", "running tritonai harness windows installer"] },
    { id: "copy", label: "Copy the app into staging", match: ["copied tritonai harness app to staging", "windows installer completed"] },
    { id: "validate", label: "Verify the staged app", match: ["verified staged tritonai harness app", "after the windows installer completed"] },
    { id: "install", label: "Install the app into its managed location", match: ["installed tritonai harness app into its managed location"] },
    { id: "cleanup", label: "Close the app package", match: ["closing tritonai harness installer image", "closed tritonai harness installer image"] },
    { id: "launcher", label: "Create the launcher users will open", match: ["launcher", "shortcut", "applications"] }
  ],
  verify: [
    { id: "paths", label: "Record the installed setup", match: ["recorded the installed tritonai installer version"] },
    { id: "ready", label: `Mark ${TRITONAI_APP_DISPLAY_NAME} ready to open`, match: ["finished"] }
  ]
};

const connectStepIndex = installSteps.findIndex((step) => step.id === "connect");
const panels = {
  credentials: document.getElementById("credentials-panel") as HTMLElement | null
};

const log = document.getElementById("log") as HTMLElement;
const result = document.getElementById("result") as HTMLElement;
const installChecklist = document.getElementById("install-checklist") as HTMLElement;
const progressBar = document.getElementById("progress-bar") as HTMLElement;
const progressValue = document.getElementById("progress-value") as HTMLElement;
const progressTrack = document.querySelector(".progress-track") as HTMLElement | null;
const eventLog = document.getElementById("event-log") as HTMLElement;
const connectionTitle = document.getElementById("connection-title") || document.getElementById("install-title");
const connectionSubtitle = document.getElementById("connection-subtitle");
const previewOpen = document.getElementById("preview-open") as HTMLButtonElement | null;
const previewStatus = document.getElementById("preview-status");
const setupTitle = document.getElementById("credentials-title");
const setupCopy = document.getElementById("credentials-copy");
const inlineProgress = document.getElementById("inline-progress");
const installerVersionLabel = document.getElementById("installer-version-label");
const apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
const apiKeyHelp = document.getElementById("api-key-help");
const apiKeyVisibilityToggle = document.getElementById("api-key-visibility-toggle");
const continueButton = document.getElementById("continue-button") as HTMLButtonElement;

function show(panelName) {
  Object.entries(panels).forEach(([name, panel]) => {
    if (!panel) return;
    panel.classList.toggle("active", name === "credentials");
  });

  if (panelName === "credentials" && state.installPhase !== "running" && state.installPhase !== "complete") {
    document.body.classList.remove("install-started");
    if (inlineProgress) inlineProgress.hidden = true;
  }

  updateStepRail(panelName);
}

function updateStepRail(panelName = state.installPhase === "idle" ? "credentials" : "install") {
  const activeStep = getActiveRailStep(panelName);
  document.querySelectorAll<HTMLElement>(".step-rail li").forEach((step) => {
    const stepName = step.dataset.step;
    const needsAttention = isRailStepAttention(stepName);
    step.classList.toggle("attention", needsAttention);
    step.classList.toggle("active", stepName === activeStep && !needsAttention);
    step.classList.toggle("complete", isStepComplete(stepName, panelName));
  });
}

function getActiveRailStep(panelName) {
  if (state.installPhase === "complete") return "finish";
  if (isRailStepAttention("credentials")) return "credentials";
  if (state.installPhase === "running") {
    return hasCompletedTritonAiAccessStep() ? "install" : "credentials";
  }
  if (state.installPhase === "attention") {
    return hasCompletedTritonAiAccessStep() ? "install" : "credentials";
  }
  return panelName;
}

function isStepComplete(stepName, panelName) {
  const order = ["credentials", "install", "finish"];
  const mappedPanel = getActiveRailStep(panelName);
  if (isRailStepAttention(stepName)) {
    return false;
  }
  if (stepName === "credentials") {
    return hasCompletedTritonAiAccessStep();
  }
  if (stepName === "finish" && state.installResponse) {
    return true;
  }
  if (stepName === "install" && state.installPhase === "complete") {
    return true;
  }
  return order.indexOf(stepName) < order.indexOf(mappedPanel);
}

function isRailStepAttention(stepName) {
  if (stepName !== "credentials") {
    return false;
  }
  return Boolean(state.credentialError) || (
    state.installPhase === "attention"
    && !hasCompletedTritonAiAccessStep()
    && connectStepIndex >= 0
    && state.installStepIndex === connectStepIndex
  );
}

function hasCompletedTritonAiAccessStep() {
  if (state.installPhase === "complete" || state.installResponse) {
    return true;
  }
  return connectStepIndex >= 0 && state.installStepIndex > connectStepIndex;
}

async function init() {
  const platform = await installerApi.getPlatform();
  state.platform = platform.platform || "unknown";
  state.docsUrl = platform.managedConfig && platform.managedConfig.apiDocsUrl
    ? platform.managedConfig.apiDocsUrl
    : "";
  updateDocsControls();
  if (platform.version && installerVersionLabel) {
    installerVersionLabel.textContent = `Installer v${platform.version}`;
  }
  prefillExistingApiKey(platform.existingApiKey);
  resetInstallUi();

  installerApi.onLog((message) => {
    if (!message) return;
    const displayMessage = brandCopy(message);
    log.textContent += `${displayMessage}\n`;
    log.scrollTop = log.scrollHeight;
    if (state.installPhase === "running") {
      addInstallEvent(displayMessage);
    }
  });
}

function updateDocsControls() {
  for (const id of ["open-docs", "open-docs-footer"]) {
    const control = document.getElementById(id) as HTMLButtonElement | null;
    if (!control) continue;
    const isInstalling = state.installPhase === "running";
    control.hidden = false;
    control.disabled = isInstalling;
    control.setAttribute("aria-disabled", String(isInstalling));
    control.title = isInstalling
      ? "TritonAI access key documentation is unavailable while setup is running."
      : state.docsUrl
      ? "Open TritonAI access key documentation"
      : "TritonAI access key documentation is not configured for this build.";
  }
}

function prefillExistingApiKey(existingApiKey) {
  const apiKey = existingApiKey && typeof existingApiKey.apiKey === "string"
    ? existingApiKey.apiKey.trim()
    : "";
  if (!apiKey || apiKeyInput.value.trim()) {
    return;
  }

  apiKeyInput.value = apiKey;
  state.prefilledApiKey = apiKey;
  updateCredentialControls();
}

async function openConfiguredDocs() {
  if (!state.docsUrl) {
    showDocsUnavailable();
    return;
  }

  try {
    await installerApi.openDocs(state.docsUrl);
  } catch (_error) {
    showDocsUnavailable();
  }
}

function showDocsUnavailable() {
  if (!apiKeyHelp) return;
  apiKeyHelp.classList.remove("is-ready");
  apiKeyHelp.classList.add("is-error");
  apiKeyHelp.textContent = "TritonAI access key documentation is not configured for this installer build.";
}

function renderInstallChecklist(statuses = {}) {
  if (!installChecklist) return;
  installChecklist.innerHTML = installSteps
    .map((step) => {
      const status = statuses[step.id] || "pending";
      return `
        <li class="${status}" data-install-step="${step.id}">
          <span class="step-check" aria-hidden="true">&#10003;</span>
          <div>
            <strong>${step.label}</strong>
            <small>${getStatusText(status)}</small>
          </div>
        </li>
      `;
    })
    .join("");
}

function getStatusText(status) {
  if (status === "complete") return "Completed";
  if (status === "active") return "In progress...";
  if (status === "attention") return "Stopped";
  return "Pending";
}

function resetInstallUi() {
  state.installStepIndex = -1;
  state.events = [];
  state.detailProgress = {};
  state.progressValue = 0;
  renderInstallChecklist();
  renderEventLog();
  updateProgress(0);
  updateConnectionCopy();
  setPreviewReady(false);
  updateStepRail("credentials");
}

function addInstallEvent(message) {
  const nextIndex = getInstallStepIndex(message);
  if (nextIndex >= 0) {
    markPreviousStepsComplete(nextIndex);
    state.installStepIndex = Math.max(state.installStepIndex, nextIndex);
  } else if (state.installStepIndex < 0) {
    state.installStepIndex = 0;
  }

  const isFinished = message.toLowerCase().includes("finished");
  if (isFinished) {
    state.installStepIndex = installSteps.length - 1;
    markPreviousStepsComplete(state.installStepIndex);
    markStepComplete("verify");
  }

  const detail = getInstallDetail(message, state.installStepIndex);
  if (detail) {
    state.detailProgress[detail.stepId] = Math.max(
      state.detailProgress[detail.stepId] ?? -1,
      detail.index
    );
    state.events.push({
      message: detail.label,
      status: isFinished ? "complete" : "active",
      stepId: detail.stepId,
      detailIndex: detail.index,
      time: formatTime(new Date())
    });
  }

  renderInstallProgress({ finished: isFinished });
}

function getInstallStepIndex(message) {
  const normalized = message.toLowerCase();
  return installSteps.reduce((matchedIndex, step, index) => (
    step.match.some((fragment) => normalized.includes(fragment)) ? index : matchedIndex
  ), -1);
}

function getInstallDetail(message, fallbackStepIndex) {
  const normalized = message.toLowerCase();
  const candidateIndexes = [
    getInstallStepIndex(message),
    fallbackStepIndex,
    Math.max(0, state.installStepIndex)
  ].filter((index) => index >= 0);

  for (const stepIndex of candidateIndexes) {
    const step = installSteps[stepIndex];
    const details = step && installStepDetails[step.id];
    if (!details) continue;
    const detailIndex = details.findIndex((detail) => (
      detail.match.some((fragment) => normalized.includes(fragment))
    ));
    if (detailIndex >= 0) {
      return {
        stepId: step.id,
        index: detailIndex,
        label: details[detailIndex].label
      };
    }
  }

  return null;
}

function markPreviousStepsComplete(nextIndex) {
  installSteps.slice(0, nextIndex).forEach((step) => {
    markStepComplete(step.id);
  });
}

function markStepComplete(stepId) {
  const details = installStepDetails[stepId] || [];
  if (details.length) {
    state.detailProgress[stepId] = details.length - 1;
  }
}

function renderInstallProgress({ finished = false } = {}) {
  if (finished) {
    renderInstallChecklist(Object.fromEntries(installSteps.map((step) => [step.id, "complete"])));
    markEventsComplete();
    renderEventLog();
    updateConnectionCopy();
    updateProgress(100);
    updateStepRail("install");
    return;
  }

  const currentIndex = Math.max(0, state.installStepIndex);
  const statuses = {};

  installSteps.forEach((step, index) => {
    if (index < currentIndex) {
      statuses[step.id] = "complete";
    } else if (index === currentIndex) {
      statuses[step.id] = "active";
    } else {
      statuses[step.id] = "pending";
    }
  });

  renderInstallChecklist(statuses);
  renderEventLog();
  updateConnectionCopy();
  updateProgress(getProgressForStep(currentIndex));
  updateStepRail("install");
}

function updateProgress(value) {
  const boundedValue = Math.max(0, Math.min(100, Math.round(value)));
  state.progressValue = Math.max(state.progressValue, boundedValue);
  if (!progressValue || !progressBar || !progressTrack) return;
  progressValue.textContent = `${state.progressValue}%`;
  progressBar.style.width = `${state.progressValue}%`;
  progressTrack.setAttribute("aria-valuenow", String(state.progressValue));
}

function getProgressForStep(stepIndex) {
  const step = installSteps[stepIndex];
  if (!step) return 0;
  return getInstallProgress(state.platform, step.id, state.detailProgress[step.id] ?? -1);
}

function updateConnectionCopy() {
  if (!connectionTitle || !connectionSubtitle) return;

  if (state.installPhase === "idle") {
    connectionTitle.textContent = "Ready to install";
    connectionSubtitle.textContent = "Start setup to see live installer progress.";
    return;
  }

  if (state.installPhase === "complete") {
    connectionTitle.textContent = `${TRITONAI_APP_DISPLAY_NAME} is ready`;
    connectionSubtitle.textContent = "Installation finished and the launcher is available.";
    return;
  }

  if (state.installPhase === "attention") {
    connectionTitle.textContent = "Setup needs attention";
    connectionSubtitle.textContent = "Review the last installer event and try again when ready.";
    return;
  }

  const activeStep = installSteps[Math.max(0, state.installStepIndex)] || installSteps[0];
  connectionTitle.textContent = activeStep.id === "connect" ? "Connecting to TritonAI..." : `${activeStep.label}...`;
  connectionSubtitle.textContent = getConnectionSubtitle(activeStep.id);
}

function getConnectionSubtitle(stepId) {
  if (stepId === "prepare") return "Checking this computer and preparing local UCSD folders.";
  if (stepId === "tools") return "Installing and verifying TritonAI support components.";
  if (stepId === "connect") return "Verifying UC San Diego-managed TritonAI access.";
  if (stepId === "shortcut") return `Installing ${TRITONAI_APP_DISPLAY_NAME} and preparing the launcher.`;
  return "Checking the installed setup.";
}

function renderEventLog() {
  if (!eventLog) return;

  if (state.installPhase === "idle") {
    eventLog.innerHTML = `<li class="pending"><time>--:--:--</time><span>Waiting for setup to start</span><b aria-hidden="true"></b></li>`;
    return;
  }

  if (state.installPhase === "attention") {
    const event = state.events[state.events.length - 1];
    eventLog.innerHTML = `
      <li class="attention">
        <time>${event ? event.time : "--:--:--"}</time>
        <span>${escapeHtml(event ? event.message : "Setup paused before finishing")}</span>
        <b aria-hidden="true"></b>
      </li>
    `;
    return;
  }

  const stepIndex = state.installPhase === "complete"
    ? installSteps.length - 1
    : Math.max(0, state.installStepIndex);
  const step = installSteps[stepIndex] || installSteps[0];
  const details = installStepDetails[step.id] || [];
  const completedIndex = state.detailProgress[step.id] ?? -1;

  if (details.length === 0) {
    eventLog.innerHTML = `<li class="pending"><time>--:--:--</time><span>Preparing status details</span><b aria-hidden="true"></b></li>`;
    return;
  }

  eventLog.innerHTML = details
    .map((detail, index) => {
      const status = index <= completedIndex
        ? "complete"
        : index === completedIndex + 1 && state.installPhase === "running"
          ? "active"
          : "pending";
      const time = getDetailTime(step.id, index) || (status === "complete" ? "Done" : "--:--:--");
      return `
        <li class="${status}">
          <time>${time}</time>
          <span>${escapeHtml(detail.label)}</span>
          <b class="${status === "active" ? "active-dot" : ""}" aria-hidden="true">${status === "complete" ? "&#10003;" : ""}</b>
        </li>
      `;
    })
    .join("");
}

function markEventsComplete() {
  state.events = state.events.map((event) => ({ ...event, status: "complete" }));
  installSteps.forEach((step) => markStepComplete(step.id));
}

function getDetailTime(stepId, detailIndex) {
  const event = state.events
    .filter((entry) => entry.stepId === stepId && entry.detailIndex === detailIndex)
    .pop();
  return event && event.time;
}

function summarizeInstallerEvent(message) {
  const normalized = message.toLowerCase();
  if (normalized.startsWith("$ ")) return "Running installer command";
  if (normalized.includes("creating ucsd") || normalized.includes("setup folder")) return "Prepared UC San Diego setup folders";
  if (normalized.includes("checking installer prerequisites") || normalized.includes("checking this computer")) return "Checked this computer";
  if (normalized.includes("runtime")) return "Prepared local runtime";
  if (normalized.includes("access key") || normalized.includes("environment")) return "Stored TritonAI access settings";
  if (normalized.includes("checking tritonai connection")) return "Checking TritonAI access";
  if (normalized.includes("connection verified")) return "Verified TritonAI access";
  if (normalized.includes("configuring") || normalized.includes("routing")) return "Configured UC San Diego routing";
  if (normalized.includes("installing") && (normalized.includes("support components") || normalized.includes("codex") || normalized.includes("cli"))) return "Installed TritonAI support components";
  if (normalized.includes("support components") || normalized.includes("codex") || normalized.includes("cli")) return "Verified TritonAI support components";
  if (normalized.includes("desktop") || normalized.includes("launcher") || normalized.includes("shortcut")) return `Prepared ${TRITONAI_APP_DISPLAY_NAME} launch`;
  if (normalized.includes("finished")) return "Installation complete";
  return message;
}

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function setPreviewReady(isReady) {
  if (!previewOpen || !previewStatus) return;
  previewOpen.disabled = !isReady;
  previewOpen.classList.toggle("primary", isReady);
  previewOpen.classList.toggle("secondary", !isReady);
  previewStatus.textContent = isReady
    ? `${TRITONAI_APP_DISPLAY_NAME} is installed and ready to open.`
    : `${TRITONAI_APP_DISPLAY_NAME} will be ready to open from this installer.`;
}

function renderComplete(response) {
  state.installPhase = "complete";
  updateCredentialControls();
  state.installStepIndex = installSteps.length;
  state.installResponse = response;
  state.supportInfo = response.diagnostics || null;
  if (setupTitle) setupTitle.textContent = "Ready to use";
  if (setupCopy) setupCopy.textContent = `${TRITONAI_APP_DISPLAY_NAME} is installed and ready to open.`;
  if (inlineProgress) inlineProgress.hidden = true;
  const installTitle = document.getElementById("install-title");
  if (installTitle) installTitle.textContent = "Ready to use";
  updateConnectionCopy();
  renderInstallChecklist(Object.fromEntries(installSteps.map((step) => [step.id, "complete"])));
  markEventsComplete();
  renderEventLog();
  updateProgress(100);
  setPreviewReady(getLaunchTools(response).length > 0);
  updateStepRail("install");

  const launchTools = getLaunchTools(response);
  const manualActions = getManualActions(response);
  result.innerHTML = `
    <div class="success-card compact-result">
      <div>
        <h3>Installation complete</h3>
        <div class="actions compact">
          ${launchTools.map((tool, index) => `
            <button type="button" class="${index === 0 ? "primary" : "secondary"}" data-action="open-tool" data-tool-id="${tool.id}">${tool.label}</button>
          `).join("")}
          ${manualActions.map((action) => `
            <button type="button" class="${launchTools.length === 0 ? "primary" : "secondary"}" data-action="open-manual-url" data-url="${escapeHtml(action.url)}">${action.label}</button>
          `).join("")}
          <button type="button" class="secondary" data-action="close-installer">Close installer</button>
        </div>
      </div>
    </div>
  `;
}

function getLaunchTools(response) {
  const apps = response.desktopApps || {};
  return [
    apps.t3codeShortcut || apps.t3code
      ? { id: "t3code", label: `Open ${TRITONAI_APP_DISPLAY_NAME}` }
      : null
  ].filter(Boolean);
}

function getLauncherSummary(response) {
  const apps = response.desktopApps || {};
  const hasShortcutOrLauncher = Boolean(
    apps.t3codeShortcut
  );

  if (!hasShortcutOrLauncher) {
    return "Applications checked";
  }

  return state.platform === "win32"
    ? "Desktop shortcut added"
    : "Application added";
}

function getManualActions(response) {
  return [];
}

function renderAttention(error) {
  state.installPhase = "attention";
  updateCredentialControls();
  if (setupTitle) setupTitle.textContent = "Setup paused";
  if (setupCopy) setupCopy.textContent = "Review the issue below, then try again.";
  const installTitle = document.getElementById("install-title");
  if (installTitle) installTitle.textContent = "Setup paused";
  const failedStepIndex = getFailureStepIndex(error);
  state.installStepIndex = failedStepIndex;
  const statuses = getAttentionStatuses(failedStepIndex);
  renderInstallChecklist(statuses);
  const errorMessage = getInstallerErrorMessage(error);
  if (isAccessKeyError(errorMessage)) {
    setCredentialError("API key error: TritonAI rejected this access key. Confirm it is active, then try again.");
  }
  state.events.push({
    message: errorMessage,
    status: "attention",
    time: formatTime(new Date())
  });
  renderEventLog();
  updateConnectionCopy();
  updateProgress(getProgressForStep(failedStepIndex));
  setPreviewReady(false);
  updateStepRail("install");

  result.innerHTML = `
    <div class="attention-card compact-result">
      <div class="attention-icon" aria-hidden="true">!</div>
      <div>
        <h3>One step needs attention</h3>
        <p>${escapeHtml(errorMessage)}</p>
        <div class="actions compact">
          <button type="button" class="primary" data-action="retry-install">Try again</button>
          <button type="button" class="secondary" data-action="back-to-credentials">Review access</button>
          <button type="button" class="secondary" data-action="copy-support-report">Copy report</button>
          <button type="button" class="secondary" data-action="show-logs">Show logs</button>
          ${state.docsUrl ? '<button type="button" class="link-button" id="open-docs-from-error">Get help</button>' : ""}
        </div>
      </div>
    </div>
  `;
}

function getFailureStepIndex(error) {
  const errorMessage = getInstallerErrorMessage(error);
  if (isAccessKeyError(errorMessage)) {
    return installSteps.findIndex((step) => step.id === "connect");
  }

  return Math.max(0, Math.min(state.installStepIndex, installSteps.length - 1));
}

function getAttentionStatuses(failedStepIndex) {
  return Object.fromEntries(installSteps.map((step, index) => {
    if (index < failedStepIndex) return [step.id, "complete"];
    if (index === failedStepIndex) return [step.id, "attention"];
    return [step.id, "pending"];
  }));
}

function getInstallerErrorMessage(error) {
  const rawMessage = error && error.message
    ? error.message
    : "The installer paused before finishing.";
  return brandCopy(rawMessage)
    .replace(/^Error invoking remote method 'installer:start': Error:\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function isAccessKeyError(message) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("tritonai rejected the access key")
    || normalized.includes("access key is required");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function brandCopy(value) {
  return String(value);
}

function updateCredentialControls() {
  const hasApiKey = Boolean(apiKeyInput.value.trim());
  const isInstalling = state.installPhase === "running";
  const isComplete = state.installPhase === "complete";
  continueButton.disabled = !hasApiKey || isInstalling || isComplete;
  continueButton.setAttribute("aria-busy", String(isInstalling));
  if (apiKeyHelp) {
    apiKeyHelp.classList.toggle("is-error", Boolean(state.credentialError));
    apiKeyHelp.classList.toggle("is-ready", hasApiKey && !state.credentialError);
  }
  apiKeyInput.setAttribute("aria-invalid", state.credentialError ? "true" : "false");
  const inputWrap = apiKeyInput.closest(".input-wrap");
  if (inputWrap) {
    inputWrap.classList.toggle("is-error", Boolean(state.credentialError));
  }
  if (apiKeyHelp) {
    apiKeyHelp.textContent = state.credentialError || getCredentialHelpText(hasApiKey);
  }
}

function getCredentialHelpText(hasApiKey) {
  if (hasApiKey && state.prefilledApiKey && apiKeyInput.value.trim() === state.prefilledApiKey) {
    return "Found an existing TritonAI access key on this computer.";
  }

  return "Required for UC San Diego-managed model access.";
}

function setCredentialError(message) {
  state.credentialError = message;
  apiKeyInput.setCustomValidity(message);
  updateCredentialControls();
}

function clearCredentialError() {
  state.credentialError = null;
  apiKeyInput.setCustomValidity("");
  updateCredentialControls();
}

function handleCredentialInput() {
  if (state.prefilledApiKey && apiKeyInput.value.trim() !== state.prefilledApiKey) {
    state.prefilledApiKey = "";
  }
  clearCredentialError();
}

function refreshCredentialControlsSoon() {
  setTimeout(updateCredentialControls, 0);
}

function setApiKeyVisible(isVisible) {
  if (!apiKeyInput || !apiKeyVisibilityToggle) return;
  apiKeyInput.type = isVisible ? "text" : "password";
  apiKeyVisibilityToggle.classList.toggle("is-visible", isVisible);
  apiKeyVisibilityToggle.setAttribute("aria-pressed", String(isVisible));
  apiKeyVisibilityToggle.setAttribute(
    "aria-label",
    isVisible ? "Hide TritonAI access key" : "Show TritonAI access key"
  );
  apiKeyVisibilityToggle.title = isVisible ? "Hide access key" : "Show access key";
}

(document.getElementById("credentials-form") as HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  state.apiKey = apiKeyInput.value.trim();
  if (!state.apiKey) {
    apiKeyInput.setCustomValidity("Enter your TritonAI access key to continue.");
    apiKeyInput.reportValidity();
    updateCredentialControls();
    return;
  }
  clearCredentialError();
  startInstallFlow();
});

apiKeyInput.addEventListener("input", handleCredentialInput);
apiKeyInput.addEventListener("change", handleCredentialInput);
apiKeyInput.addEventListener("keyup", updateCredentialControls);
apiKeyInput.addEventListener("paste", refreshCredentialControlsSoon);
apiKeyInput.addEventListener("drop", refreshCredentialControlsSoon);
apiKeyInput.addEventListener("focus", updateCredentialControls);

apiKeyVisibilityToggle?.addEventListener("click", () => {
  setApiKeyVisible(apiKeyInput.type === "password");
  apiKeyInput.focus();
});

document.getElementById("open-docs")?.addEventListener("click", () => {
  openConfiguredDocs();
});

document.getElementById("open-docs-footer")?.addEventListener("click", () => {
  openConfiguredDocs();
});

const apiKeyInfoButton = document.getElementById("api-key-info-button");
const apiKeyInfoPopover = document.getElementById("api-key-info-popover");

function setApiKeyInfoOpen(isOpen) {
  if (!apiKeyInfoButton || !apiKeyInfoPopover) return;
  apiKeyInfoPopover.hidden = !isOpen;
  apiKeyInfoButton.setAttribute("aria-expanded", String(isOpen));
}

apiKeyInfoButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  setApiKeyInfoOpen(apiKeyInfoPopover.hidden);
});

document.addEventListener("click", (event) => {
  if (!apiKeyInfoPopover) return;
  if (apiKeyInfoPopover.hidden) return;
  if (event.target instanceof Element && event.target.closest(".key-info-wrap")) return;
  setApiKeyInfoOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    setApiKeyInfoOpen(false);
  }
});

async function startInstallFlow() {
  document.body.classList.add("install-started");
  if (inlineProgress) inlineProgress.hidden = false;
  if (setupTitle) setupTitle.textContent = `Installing ${TRITONAI_APP_DISPLAY_NAME}`;
  if (setupCopy) setupCopy.textContent = "Please wait while we set things up.";
  log.textContent = "";
  result.textContent = "";
  state.installPhase = "running";
  updateCredentialControls();
  state.installStepIndex = -1;
  state.installResponse = null;
  state.supportInfo = null;
  state.events = [];
  state.detailProgress = {};
  state.progressValue = 0;
  renderInstallChecklist();
  renderEventLog();
  updateProgress(0);
  setPreviewReady(false);
  updateConnectionCopy();
  const installTitle = document.getElementById("install-title");
  if (installTitle) installTitle.textContent = `Installing ${TRITONAI_APP_DISPLAY_NAME}`;
  show("install");

  try {
    const response = await installerApi.startInstall({
      apiKey: state.apiKey
    });

    renderComplete(response);
  } catch (error) {
    state.supportInfo = await getLatestSupportInfo();
    renderAttention(error);
  }
}

result.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const action = target.dataset.action || target.id;
  if (action === "back-to-credentials") {
    show("credentials");
  }
  if (action === "retry-install") {
    startInstallFlow();
  }
  if (action === "open-tool") {
    await installerApi.finishInstall({
      openTool: target.dataset.toolId,
      desktopApps: state.installResponse && state.installResponse.desktopApps
    });
  }
  if (action === "open-manual-url") {
    installerApi.openDocs(target.dataset.url || "");
  }
  if (action === "close-installer") {
    await installerApi.finishInstall({});
  }
  if (action === "open-docs-from-error") {
    openConfiguredDocs();
  }
  if (action === "copy-support-report") {
    await copySupportReport(target as HTMLButtonElement);
  }
  if (action === "show-logs") {
    await showLogs(target as HTMLButtonElement);
  }
});

async function getLatestSupportInfo() {
  if (!installerApi.getSupportInfo) return null;
  try {
    return await installerApi.getSupportInfo();
  } catch (_error) {
    return null;
  }
}

async function copySupportReport(button) {
  if (!installerApi.copySupportReport) return;
  const originalText = button.textContent;
  try {
    state.supportInfo = await installerApi.copySupportReport();
    button.textContent = "Copied";
  } catch (_error) {
    button.textContent = "Unavailable";
  } finally {
    setTimeout(() => {
      button.textContent = originalText;
    }, 1800);
  }
}

async function showLogs(button) {
  if (!installerApi.showLogs) return;
  const originalText = button.textContent;
  try {
    state.supportInfo = await installerApi.showLogs();
  } catch (_error) {
    button.textContent = "Unavailable";
    setTimeout(() => {
      button.textContent = originalText;
    }, 1800);
  }
}

previewOpen?.addEventListener("click", async () => {
  if (!state.installResponse || previewOpen.disabled) return;
  await installerApi.finishInstall({
    openTool: "t3code",
    desktopApps: state.installResponse.desktopApps
  });
});

updateCredentialControls();
init();

function createPreviewInstallerApi(): InstallerApi {
  const listeners: InstallerEmit[] = [];
  const preview = {
    id: "t3code",
    name: TRITONAI_APP_DISPLAY_NAME,
    recommended: true,
    description: "Desktop GUI for UCSD-managed coding agents, backed by TritonAI.",
    commands: ["Prepare TritonAI model access", `Install bundled ${TRITONAI_APP_DISPLAY_NAME} desktop app`]
  };

  return {
    getPlatform: async () => ({
      platform: "preview",
      home: "~",
      version: "0.1.7",
      preview,
      managedConfig: {
        apiDocsUrl: ""
      },
      existingApiKey: null
    }),
    openDocs: async (url) => {
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    },
    startInstall: async (payload) => {
      const steps = [
        "Preview mode: no files will be written.",
        "Creating UCSD setup folder...",
        "Checking this computer...",
        "Preparing the private app runtime...",
        "Checking TritonAI connection...",
        "TritonAI connection verified.",
        "Saving TritonAI access key...",
        "Installing TritonAI support components if needed...",
        "Verifying TritonAI support components...",
        "Configuring TritonAI access for UCSD routing...",
        `Installing ${TRITONAI_APP_DISPLAY_NAME} desktop app...`,
        `Verified ${TRITONAI_APP_DISPLAY_NAME} installer image.`,
        `Mounted ${TRITONAI_APP_DISPLAY_NAME} installer image.`,
        `Copied ${TRITONAI_APP_DISPLAY_NAME} app to staging.`,
        `Verified staged ${TRITONAI_APP_DISPLAY_NAME} app.`,
        `Installed ${TRITONAI_APP_DISPLAY_NAME} app into its managed location.`,
        `Closing ${TRITONAI_APP_DISPLAY_NAME} installer image.`,
        `${TRITONAI_APP_DISPLAY_NAME} launcher installed at /Applications/${TRITONAI_APP_DISPLAY_NAME}.app`,
        "Recorded the installed TritonAI Installer version.",
        "Install flow finished."
      ];

      for (const step of steps) {
        listeners.forEach((listener) => listener(step));
        await new Promise((resolve) => setTimeout(resolve, 90));
      }

      return {
        ok: true,
        paths: {
          ucsdRoot: "~/.agents/ucsd",
          envFile: "~/.agents/ucsd/env",
          codexHome: "~/.tritonai-harness/codex",
          t3Settings: "~/.tritonai-harness/userdata/settings.json",
          logsDir: "~/.agents/ucsd/logs"
        },
        desktopApps: {
          t3code: "/Applications/TritonAI Harness.app",
          t3codeShortcut: "/Applications/TritonAI Harness.app"
        }
      };
    },
    finishInstall: async () => {},
    getSupportInfo: async () => ({
      logsDir: "~/.agents/ucsd/logs",
      logFile: "~/.agents/ucsd/logs/installer-preview.log",
      supportReportFile: "~/.agents/ucsd/logs/support-report-preview.json"
    }),
    copySupportReport: async () => ({
      logsDir: "~/.agents/ucsd/logs",
      logFile: "~/.agents/ucsd/logs/installer-preview.log",
      supportReportFile: "~/.agents/ucsd/logs/support-report-preview.json"
    }),
    showLogs: async () => ({
      logsDir: "~/.agents/ucsd/logs",
      logFile: "~/.agents/ucsd/logs/installer-preview.log",
      supportReportFile: "~/.agents/ucsd/logs/support-report-preview.json"
    }),
    onLog: (callback) => {
      listeners.length = 0;
      listeners.push(callback);
    }
  };
}
