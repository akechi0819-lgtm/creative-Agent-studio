Add-Type -AssemblyName System.Windows.Forms

$choice = [System.Windows.Forms.MessageBox]::Show(
  "是：启动或打开工作台`n否：停止工作台`n取消：退出",
  "Creative Agent Studio",
  [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
  [System.Windows.Forms.MessageBoxIcon]::Question
)
if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { exit 0 }

$rootPath = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $rootPath ".studio-runtime\node\node-v22.23.3-win-x64\node.exe"
$launcherPath = Join-Path $rootPath "release\launcher.mjs"
$action = if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { "start" } else { "stop" }

try {
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Creative Agent Studio"
  $form.Width = 430
  $form.Height = 128
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.ControlBox = $false
  $label = New-Object System.Windows.Forms.Label
  $label.Text = if ($action -eq "start") {
    "首次启动会准备本机 Python/OCR，可能下载依赖；请保持窗口打开…"
  } else {
    "正在停止工作台及已识别的本机服务，请稍候…"
  }
  $label.AutoSize = $false
  $label.Left = 18
  $label.Top = 18
  $label.Width = 390
  $label.Height = 30
  $form.Controls.Add($label)
  $progress = New-Object System.Windows.Forms.ProgressBar
  $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
  $progress.MarqueeAnimationSpeed = 28
  $progress.Left = 18
  $progress.Top = 58
  $progress.Width = 390
  $progress.Height = 20
  $form.Controls.Add($progress)

  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $nodePath
  $processInfo.Arguments = ('"{0}" {1}' -f $launcherPath, $action)
  $processInfo.WorkingDirectory = $rootPath
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $processInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $processInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $processInfo
  if (-not $process.Start()) { throw "无法启动包内 Node.js。" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $form.Show()
  while (-not $process.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }
  $process.WaitForExit()
  $form.Close()
  $exitCode = $process.ExitCode
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  $output = ($stdout + [Environment]::NewLine + $stderr).Trim()
  $process.Dispose()
  $icon = if ($exitCode -eq 0) { [System.Windows.Forms.MessageBoxIcon]::Information } else { [System.Windows.Forms.MessageBoxIcon]::Warning }
  $title = if ($exitCode -eq 0) { "Creative Agent Studio" } else { "操作未完成" }
  [void][System.Windows.Forms.MessageBox]::Show($output.Trim(), $title, [System.Windows.Forms.MessageBoxButtons]::OK, $icon)
  exit $exitCode
} catch {
  [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "操作未完成", [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)
  exit 1
}
