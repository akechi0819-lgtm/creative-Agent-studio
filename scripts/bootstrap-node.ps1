param(
  [Parameter(Mandatory = $true)]
  [string] $Root
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PinnedVersion = '22.23.3'
$RuntimeRoot = Join-Path $Root '.studio-runtime\node'

function Get-Sha256Hex([string] $Path) {
  $Algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $Stream = [System.IO.File]::OpenRead($Path)
    try {
      return [System.BitConverter]::ToString($Algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant()
    } finally {
      $Stream.Dispose()
    }
  } finally {
    $Algorithm.Dispose()
  }
}

function Test-SupportedNode([string] $NodePath) {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
  & $NodePath -e 'const version = process.versions.node; const [major, minor] = version.split(/\./).map(Number); process.exit(/^\d+\.\d+\.\d+$/.test(version) && ((major === 22 && minor >= 19) || major >= 24) ? 0 : 1)' *> $null
  return $LASTEXITCODE -eq 0
}

$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($SystemNode -and (Test-SupportedNode $SystemNode.Source)) {
  $SystemNpm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $SystemNpm) { $SystemNpm = Get-Command npm.exe -ErrorAction SilentlyContinue | Select-Object -First 1 }
  if ($SystemNpm) {
    [Console]::Out.WriteLine($SystemNode.Source)
    exit 0
  }
}

$Architecture = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $Architecture = $env:PROCESSOR_ARCHITEW6432 }
if (-not $Architecture) {
  [Console]::Error.WriteLine('Cannot determine Windows processor architecture.')
  exit 2
}
switch ($Architecture.ToUpperInvariant()) {
  'AMD64' {
    $NodeArchitecture = 'win-x64'
    $ExpectedSha256 = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
  }
  'ARM64' {
    $NodeArchitecture = 'win-arm64'
    $ExpectedSha256 = '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535'
  }
  default {
    [Console]::Error.WriteLine("Unsupported Windows architecture: $Architecture. Start.cmd supports Windows x64 and ARM64.")
    exit 2
  }
}

$ArchiveName = "node-v$PinnedVersion-$NodeArchitecture.zip"
$Target = Join-Path $RuntimeRoot "node-v$PinnedVersion-$NodeArchitecture"
$NodePath = Join-Path $Target 'node.exe'
if ((Test-SupportedNode $NodePath) -and (Test-Path -LiteralPath (Join-Path $Target 'node_modules\npm\bin\npm-cli.js'))) {
  [Console]::Out.WriteLine($NodePath)
  exit 0
}

New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
$Temp = Join-Path $RuntimeRoot ".install-$NodeArchitecture-$PID"
$ArchivePath = Join-Path $Temp $ArchiveName
$Extracted = Join-Path $Temp 'extracted'
try {
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Temp, $Extracted -Force | Out-Null
  $Url = "https://nodejs.org/download/release/v$PinnedVersion/$ArchiveName"
  [Console]::Error.WriteLine("Downloading private Node.js $PinnedVersion runtime for Windows $NodeArchitecture...")
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $downloaded = $false
  for ($attempt = 1; $attempt -le 3 -and -not $downloaded; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $ArchivePath -UseBasicParsing -TimeoutSec 300
      $downloaded = $true
    } catch {
      Remove-Item -LiteralPath $ArchivePath -Force -ErrorAction SilentlyContinue
      if ($attempt -eq 3) { throw }
      Start-Sleep -Seconds $attempt
    }
  }
  $ActualSha256 = Get-Sha256Hex $ArchivePath
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw "Node.js archive checksum mismatch: expected $ExpectedSha256, received $ActualSha256"
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Extracted)
  $ExpandedRoot = Join-Path $Extracted "node-v$PinnedVersion-$NodeArchitecture"
  if (-not (Test-Path -LiteralPath (Join-Path $ExpandedRoot 'node.exe'))) {
    throw 'The verified Node.js archive did not contain node.exe.'
  }
  Move-Item -LiteralPath $ExpandedRoot -Destination $Target
  if (-not (Test-SupportedNode $NodePath)) {
    throw 'The installed private Node.js runtime failed its version check.'
  }
  [Console]::Error.WriteLine("Installed private Node.js $PinnedVersion at $NodePath")
  [Console]::Out.WriteLine($NodePath)
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue
}
