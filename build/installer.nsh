!macro customCheckAppRunning
  retryCloseInstalledApp:
    DetailPrint "Checking for running ${PRODUCT_NAME} app..."
    nsExec::Exec `"$PowerShellPath" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$target = Join-Path -Path '$INSTDIR' -ChildPath '${APP_EXECUTABLE_FILENAME}'; $$procs = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and [string]::Equals($$_.Path, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); foreach ($$proc in $$procs) { try { Stop-Process -Id $$proc.ProcessId -Force -ErrorAction Stop } catch {} }; Start-Sleep -Milliseconds 500; $$remaining = @(Get-CimInstance -ClassName Win32_Process | Where-Object { $$_.Path -and [string]::Equals($$_.Path, $$target, [System.StringComparison]::OrdinalIgnoreCase) }); if ($$remaining.Count -gt 0) { exit 1 } else { exit 0 }"`
    Pop $0

    ${if} $0 != 0
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "The installed ${PRODUCT_NAME} app is still running and could not be closed automatically. Close it from Task Manager and click Retry to continue." /SD IDCANCEL IDRETRY retryCloseInstalledApp
      Quit
    ${endif}
!macroend
