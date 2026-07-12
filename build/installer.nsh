!macro customCheckAppRunning
  retryCloseInstalledApp:
    DetailPrint "Checking for running ${PRODUCT_NAME} app..."
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TRITONAI_NSIS_TARGET_EXECUTABLE", "$INSTDIR\${APP_EXECUTABLE_FILENAME}").r1'
    ${if} $1 == 0
      StrCpy $0 1
    ${else}
      nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = [Environment]::GetEnvironmentVariable('TRITONAI_NSIS_TARGET_EXECUTABLE', 'Process'); if ([string]::IsNullOrEmpty($$target)) { exit 1 }; $$procs = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); foreach ($$proc in $$procs) { try { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 500; $$remaining = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$_.ExecutablePath -and [string]::Equals($$_.ExecutablePath, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$remaining.Count -gt 0) { exit 1 } else { exit 0 }"`
      Pop $0
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TRITONAI_NSIS_TARGET_EXECUTABLE", "").r1'
    ${endif}

    ${if} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The installed ${PRODUCT_NAME} app is still running and could not be closed automatically. Close it from Task Manager and click Retry to continue." /SD IDCANCEL IDRETRY retryCloseInstalledApp
      Quit
    ${endif}
!macroend
