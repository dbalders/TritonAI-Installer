type InstallerEmit = (message: string) => void;

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
}

interface InstallPayload {
  apiKey: string;
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
  existingApiKey: ExistingApiKey | null;
}

interface InstallerApi {
  getPlatform(): Promise<InstallerPlatformInfo>;
  openDocs(url: string): Promise<void>;
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
