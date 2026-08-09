param(
  [Parameter(Mandatory = $true)]
  [string]$RepositoryRoot,

  [Parameter(Mandatory = $true)]
  [string]$Version,

  [Parameter(Mandatory = $true)]
  [string]$SetupPath,

  [Parameter(Mandatory = $true)]
  [string]$PortablePath,

  [Parameter(Mandatory = $true)]
  [string]$ProofPath
)

$ErrorActionPreference = "Stop"
$ProductName = "TritonAI Installer"
$UninstallRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall"
$SetupTimeoutMilliseconds = 600000
$UninstallTimeoutMilliseconds = 300000
$TerminationTimeoutMilliseconds = 10000

function Get-InstallerEntries {
  if (-not (Test-Path -LiteralPath $UninstallRoot)) { return @() }
  return @(Get-ChildItem -LiteralPath $UninstallRoot | ForEach-Object {
    Get-ItemProperty -LiteralPath $_.PSPath
  } | Where-Object { ([string]$_.DisplayName) -match '^TritonAI Installer(?: \d+\.\d+\.\d+)?$' })
}

function Wait-ForPathState([string]$Path, [bool]$ShouldExist, [int]$TimeoutSeconds = 30) {
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $Deadline) {
    if ((Test-Path -LiteralPath $Path) -eq $ShouldExist) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for path state ($ShouldExist): $Path"
}

function Wait-ForOwnedProcess($Process, [int]$TimeoutMilliseconds, [string]$Description) {
  if (-not $Process.WaitForExit($TimeoutMilliseconds)) {
    $TimedOutPid = $Process.Id
    Stop-Process -Id $TimedOutPid -Force -ErrorAction SilentlyContinue
    if (-not $Process.WaitForExit($TerminationTimeoutMilliseconds)) {
      throw "$Description timed out and process $TimedOutPid could not be terminated."
    }
    throw "$Description timed out after $TimeoutMilliseconds milliseconds; process $TimedOutPid was terminated."
  }
  $Process.WaitForExit()
  if ($Process.ExitCode -ne 0) { throw "$Description exited with code $($Process.ExitCode)." }
}

function Test-SmokeMarker($Marker) {
  if (
    $Marker.schemaVersion -ne 1 -or
    $Marker.productName -cne $ProductName -or
    $Marker.version -cne $Version -or
    $Marker.platform -cne "win32" -or
    $Marker.arch -cne "x64" -or
    $Marker.packaged -ne $true -or
    [int]$Marker.healthyForMs -lt 5000 -or
    [string]::IsNullOrWhiteSpace([string]$Marker.readyAt)
  ) {
    throw "Packaged Installer returned an invalid readiness marker."
  }
}

function Invoke-PackagedBoot([string]$ExecutablePath, [string]$CandidateId) {
  if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    throw "Packaged boot candidate does not exist: $ExecutablePath"
  }
  $MarkerPath = Join-Path ([IO.Path]::GetTempPath()) (
    "tritonai-installer-smoke-windows-{0}-{1}.json" -f $PID, [Guid]::NewGuid().ToString("N")
  )
  $UserDataPath = "$MarkerPath.userdata"
  $Process = $null
  try {
    $SmokeArgument = '"--tritonai-installer-smoke-marker={0}"' -f $MarkerPath
    $Process = Start-Process -FilePath $ExecutablePath -ArgumentList $SmokeArgument -PassThru
    $Deadline = [DateTime]::UtcNow.AddSeconds(35)
    while ([DateTime]::UtcNow -lt $Deadline -and -not $Process.HasExited -and -not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf)) {
      if ($Process.HasExited) {
        $Process.WaitForExit()
        throw "$CandidateId exited with code $($Process.ExitCode) before writing its packaged boot readiness marker."
      }
      throw "$CandidateId did not write its packaged boot readiness marker."
    }
    $Marker = Get-Content -LiteralPath $MarkerPath -Raw | ConvertFrom-Json
    Test-SmokeMarker $Marker
    Wait-ForOwnedProcess $Process $TerminationTimeoutMilliseconds "$CandidateId packaged boot"
    return $Marker
  } finally {
    if ($null -ne $Process -and -not $Process.HasExited) {
      $SmokePid = $Process.Id
      Stop-Process -Id $SmokePid -Force -ErrorAction SilentlyContinue
      if (-not $Process.WaitForExit($TerminationTimeoutMilliseconds)) {
        throw "$CandidateId process $SmokePid could not be terminated during smoke cleanup."
      }
    }
    Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $UserDataPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-QuietUninstall($Entry) {
  $QuietUninstallString = [string]$Entry.QuietUninstallString
  if ($QuietUninstallString -notmatch '^"([^"]+)"\s*(.*)$') {
    throw "Installed TritonAI Installer has no canonical quiet uninstaller."
  }
  $UninstallerPath = $Matches[1]
  $UninstallerArguments = $Matches[2]
  if (-not (Test-Path -LiteralPath $UninstallerPath -PathType Leaf) -or $UninstallerArguments -notmatch '(?:^|\s)/S(?:\s|$)') {
    throw "Installed TritonAI Installer quiet uninstaller is missing or is not silent."
  }
  $Cleanup = Start-Process -FilePath $UninstallerPath -ArgumentList $UninstallerArguments -PassThru
  Wait-ForOwnedProcess $Cleanup $UninstallTimeoutMilliseconds "TritonAI Installer cleanup"
  return Split-Path -Parent $UninstallerPath
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Packaged boot verification requires a stable semantic version." }
$SetupPath = (Resolve-Path -LiteralPath $SetupPath).Path
$PortablePath = (Resolve-Path -LiteralPath $PortablePath).Path
$RepositoryRoot = (Resolve-Path -LiteralPath $RepositoryRoot).Path
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is unavailable for the Windows release boot gate." }
$ExpectedInstalledDirectory = Join-Path $env:LOCALAPPDATA "Programs\$ProductName"
$SetupArguments = @("/S", "/D=$ExpectedInstalledDirectory")
if ((Get-InstallerEntries).Count -ne 0) {
  throw "Refusing to replace an existing TritonAI Installer during the release boot gate; use a clean Windows host."
}
if (Test-Path -LiteralPath $ExpectedInstalledDirectory) {
  throw "Refusing to replace an existing unregistered TritonAI Installer directory during the release boot gate: $ExpectedInstalledDirectory"
}

$Candidates = @()
$PortableMarker = Invoke-PackagedBoot $PortablePath "windows-portable"
$Candidates += [PSCustomObject]@{
  id = "windows-portable"
  path = [IO.Path]::GetRelativePath($RepositoryRoot, $PortablePath).Replace('\', '/')
  sha256 = Get-Sha256 $PortablePath
  marker = $PortableMarker
}

$InstalledDirectory = $ExpectedInstalledDirectory
try {
  $SetupProcess = Start-Process -FilePath $SetupPath -ArgumentList $SetupArguments -PassThru
  Wait-ForOwnedProcess $SetupProcess $SetupTimeoutMilliseconds "Windows Setup"
  $Entries = @(Get-InstallerEntries)
  if ($Entries.Count -ne 1 -or $Entries[0].DisplayVersion -cne $Version) {
    throw "Windows Setup did not register exactly one TritonAI Installer $Version installation."
  }
  $UninstallString = [string]$Entries[0].QuietUninstallString
  if ($UninstallString -notmatch '^"([^"]+)"') { throw "Installed TritonAI Installer has no canonical quiet uninstaller." }
  $UninstallerPath = $Matches[1]
  $InstalledDirectory = Split-Path -Parent $UninstallerPath
  if ($InstalledDirectory -cne $ExpectedInstalledDirectory) {
    throw "Windows Setup used an unexpected install directory: $InstalledDirectory"
  }
  $InstalledExecutable = Join-Path $InstalledDirectory "$ProductName.exe"
  Wait-ForPathState $InstalledExecutable $true
  $SetupMarker = Invoke-PackagedBoot $InstalledExecutable "windows-setup"
  $Candidates += [PSCustomObject]@{
    id = "windows-setup"
    path = [IO.Path]::GetRelativePath($RepositoryRoot, $SetupPath).Replace('\', '/')
    sha256 = Get-Sha256 $SetupPath
    marker = $SetupMarker
  }
} finally {
  $CleanupError = $null
  $Entries = @(Get-InstallerEntries)
  if ($Entries.Count -eq 1) {
    try {
      $CleanupDirectory = Invoke-QuietUninstall $Entries[0]
      if ($CleanupDirectory -cne $ExpectedInstalledDirectory) {
        throw "TritonAI Installer cleanup reported an unexpected install directory: $CleanupDirectory"
      }
    } catch {
      $CleanupError = $_
    }
  }
  $Deadline = [DateTime]::UtcNow.AddSeconds(30)
  while ([DateTime]::UtcNow -lt $Deadline -and (Get-InstallerEntries).Count -ne 0) { Start-Sleep -Milliseconds 250 }
  if ((Get-InstallerEntries).Count -ne 0) { throw "Release boot gate left a TritonAI Installer registration behind." }
  if (Test-Path -LiteralPath $ExpectedInstalledDirectory) {
    Remove-Item -LiteralPath $ExpectedInstalledDirectory -Recurse -Force
  }
  Wait-ForPathState $ExpectedInstalledDirectory $false
  if ($null -ne $CleanupError) { throw $CleanupError }
}

if ($Candidates.Count -ne 2) { throw "Windows packaged boot gate did not verify Setup and portable candidates." }
$Proof = [ordered]@{
  schemaVersion = 1
  version = $Version
  platform = "windows-x64"
  verifiedAt = [DateTime]::UtcNow.ToString("o")
  candidates = @($Candidates | Sort-Object id)
}
$ProofDirectory = Split-Path -Parent $ProofPath
[IO.Directory]::CreateDirectory($ProofDirectory) | Out-Null
$TemporaryProof = "$ProofPath.$PID.tmp"
[IO.File]::WriteAllText($TemporaryProof, (($Proof | ConvertTo-Json -Depth 8) + [Environment]::NewLine))
Move-Item -LiteralPath $TemporaryProof -Destination $ProofPath -Force
Write-Output $ProofPath
