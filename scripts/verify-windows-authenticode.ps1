param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisherName,

  [Parameter(Mandatory = $true)]
  [string]$EncodedPaths
)

$ErrorActionPreference = "Stop"
$DecodedPaths = [System.Text.Encoding]::UTF8.GetString(
  [System.Convert]::FromBase64String($EncodedPaths)
)
$Paths = @($DecodedPaths | ConvertFrom-Json)

if ($Paths.Count -eq 0) {
  throw "No Windows executables were supplied for Authenticode verification."
}

$Results = @()
foreach ($ArtifactPath in $Paths) {
  if (-not (Test-Path -LiteralPath $ArtifactPath -PathType Leaf)) {
    throw "Windows release artifact does not exist: $ArtifactPath"
  }

  $Signature = Get-AuthenticodeSignature -LiteralPath $ArtifactPath
  $PublisherName = if ($null -eq $Signature.SignerCertificate) {
    ""
  } else {
    $Signature.SignerCertificate.GetNameInfo(
      [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,
      $false
    )
  }
  if ($Signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Invalid Authenticode signature for $ArtifactPath: $($Signature.Status) $($Signature.StatusMessage)"
  }
  if ($PublisherName -cne $ExpectedPublisherName) {
    throw "Authenticode publisher mismatch for $ArtifactPath. Expected '$ExpectedPublisherName', found '$PublisherName'."
  }
  if ($null -eq $Signature.TimeStamperCertificate) {
    throw "Authenticode trusted timestamp is missing for $ArtifactPath."
  }

  $Results += [PSCustomObject]@{
    path = (Resolve-Path -LiteralPath $ArtifactPath).Path
    status = [string]$Signature.Status
    publisherName = $PublisherName
    subject = $Signature.SignerCertificate.Subject
    thumbprint = $Signature.SignerCertificate.Thumbprint
    timestampSubject = $Signature.TimeStamperCertificate.Subject
  }
}

ConvertTo-Json -InputObject @($Results) -Compress
