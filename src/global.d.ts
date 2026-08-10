type InstallerEmit = (message: string) => void;

interface TritonAiCredentials {
  sharedApiKey?: string;
  onPremApiKey?: string;
  frontierApiKey?: string;
}

interface ExistingApiKey {
  apiKey: string;
  source: string;
}

interface DesktopApps {
  [key: string]: string | undefined;
  t3code?: string;
  t3codeShortcut?: string;
  t3codeLauncher?: string;
}

interface DiagnosticsInfo {
  logsDir: string;
  logFile: string;
  supportReportFile: string;
  failedStep?: string | null;
  ok?: boolean;
  failureComponent?: string | null;
  reportAvailable?: boolean;
}

interface InstallPayload {
  credentialHandle: string;
}

interface CredentialCheckPayload {
  apiKeys?: string[];
  existingCredentialHandle?: string;
}

interface CredentialCheckResponse {
  credentialHandle: string;
  access: { onPrem: boolean; frontier: boolean };
  assignments: { onPremKeyIndex?: number; frontierKeyIndex?: number };
}

interface InstallResponse {
  ok: boolean;
  paths: Record<string, string>;
  runtime?: Record<string, string>;
  desktopApps: DesktopApps;
  managedPlugins?: {
    source: { repository: string; ref: string; commit: string };
    packages: Array<{ id: string; name: string; version: string; digest: string }>;
  } | null;
  diagnostics?: DiagnosticsInfo;
}

interface FinishPayload {
  openTool?: string;
  desktopApps?: DesktopApps;
}

interface InstallerPlatformInfo {
  platform: NodeJS.Platform | "preview" | "unknown";
  home: string;
  version: string;
  preview: unknown;
  managedConfig: {
    apiDocsUrl: string;
  };
  existingCredentials: { handle: string; source: string; keyCount: number } | null;
}

interface InstallerApi {
  getPlatform(): Promise<InstallerPlatformInfo>;
  reportReady(): Promise<void>;
  openDocs(url: string): Promise<void>;
  checkAccess(payload: CredentialCheckPayload): Promise<CredentialCheckResponse>;
  startInstall(payload: InstallPayload): Promise<InstallResponse>;
  finishInstall(payload: FinishPayload): Promise<void>;
  getSupportInfo(): Promise<DiagnosticsInfo | null>;
  copySupportReport(): Promise<DiagnosticsInfo>;
  showLogs(): Promise<DiagnosticsInfo>;
  onLog(callback: InstallerEmit): void;
}

interface Window {
  ucsdInstaller?: InstallerApi;
}
