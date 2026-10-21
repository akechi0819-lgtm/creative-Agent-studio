import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const launcherPath = fileURLToPath(new URL('../release/windows-start.ps1', import.meta.url));

test('Windows launch UI appends blank output lines and labels stderr as installation progress', {
  skip: process.platform !== 'win32' ? 'Windows PowerShell is required.' : false,
}, () => {
  const powershell = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$source = [System.IO.File]::ReadAllText($env:CAS_WINDOWS_START_SCRIPT, [System.Text.Encoding]::UTF8)
$ast = [System.Management.Automation.Language.Parser]::ParseInput(
  $source,
  [ref]$tokens,
  [ref]$parseErrors
)
if ($parseErrors.Count -gt 0) { throw ($parseErrors | Out-String) }

$requiredNames = @('Add-ProcessOutput', 'Format-Elapsed', 'Update-ElapsedStatus')
$functionSources = @{}
$ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $requiredNames -contains $node.Name
}, $true) | ForEach-Object { $functionSources[$_.Name] = $_.Extent.Text }
foreach ($name in $requiredNames) {
  if (-not $functionSources.ContainsKey($name)) { throw "Missing function in startup script: $name" }
}
Invoke-Expression (($requiredNames | ForEach-Object { $functionSources[$_] }) -join [Environment]::NewLine)

Add-Type -TypeDefinition @"
using System.Text;
public sealed class MockOutputBox {
  private readonly StringBuilder content = new StringBuilder();
  public int TextLength { get { return content.Length; } }
  public int SelectionStart { get; set; }
  public int ScrollCount { get; private set; }
  public string Value { get { return content.ToString(); } }
  public void AppendText(string value) { content.Append(value); }
  public void ScrollToCaret() { ScrollCount += 1; }
}
public sealed class MockStatusLabel {
  public string Text { get; set; }
}
"@

$script:outputBox = New-Object MockOutputBox
$script:statusLabel = New-Object MockStatusLabel
$script:elapsedWatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:latestOutput = ''
$script:latestOutputStream = ''
$script:hasLatestOutput = $false

Add-ProcessOutput -Stream 'stdout' -Line ''
if ($script:outputBox.Value -cne [Environment]::NewLine) { throw 'A blank line was not appended.' }
if ($script:outputBox.ScrollCount -ne 1) { throw 'A blank line did not scroll the output view.' }
if (-not $script:statusLabel.Text.Contains('最近运行输出：')) { throw 'Blank-line status was not updated.' }

Add-ProcessOutput -Stream 'stderr' -Line 'Downloaded fixture'
$expected = [Environment]::NewLine + "[安装进度] Downloaded fixture$([Environment]::NewLine)"
if ($script:outputBox.Value -cne $expected) { throw 'Installation progress output was not appended as expected.' }
if ($script:outputBox.ScrollCount -ne 2) { throw 'Installation progress did not scroll the output view.' }
if (-not $script:statusLabel.Text.Contains('最近安装进度：Downloaded fixture')) { throw 'Installation progress status was not updated.' }
if ($script:outputBox.Value.Contains('[错误输出]')) { throw 'Installation progress was mislabeled as an error.' }
`;

  const encodedCommand = Buffer.from(powershell, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    encodedCommand,
  ], {
    encoding: 'utf8',
    env: { ...process.env, CAS_WINDOWS_START_SCRIPT: launcherPath },
    windowsHide: true,
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `PowerShell failed. stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
