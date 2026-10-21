Add-Type -AssemblyName System.Windows.Forms

$productName = "Creative Agent Studio"
$rootPath = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $rootPath ".studio-runtime\node\node-v22.23.3-win-x64\node.exe"
$launcherPath = Join-Path $rootPath "release\launcher.mjs"
$dataRoot = if (-not [string]::IsNullOrWhiteSpace($env:STUDIO_DATA_DIR)) {
  $configuredDataRoot = $env:STUDIO_DATA_DIR
  if (-not [System.IO.Path]::IsPathRooted($configuredDataRoot)) {
    $configuredDataRoot = Join-Path $rootPath $configuredDataRoot
  }
  [System.IO.Path]::GetFullPath($configuredDataRoot)
} else {
  $localAppData = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
  Join-Path $localAppData $productName
}
$installLogPath = Join-Path $dataRoot "python-prepare.log"

# Hash the data path so independent Company data directories can start separately.
$mutexHash = [System.Security.Cryptography.SHA256]::Create()
try {
  $mutexIdentity = "{0}`n{1}" -f $productName, $dataRoot.ToUpperInvariant()
  $mutexKey = [System.BitConverter]::ToString($mutexHash.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($mutexIdentity))).Replace("-", "")
} finally {
  $mutexHash.Dispose()
}
$mutexProduct = $productName -replace "[^A-Za-z0-9]+", ""
$mutexName = "Local\CreativeAgentStudio-$mutexProduct-$mutexKey"
$startupMutex = $null
$ownsStartupMutex = $false
$form = $null
$process = $null

function Add-ProcessOutput {
  param(
    [Parameter(Mandatory = $true)][string]$Stream,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line
  )

  $prefix = if ($Stream -eq "stderr") { "[安装进度] " } else { "[运行输出] " }
  $displayLine = if ($Line.Length -eq 0) { "" } else { $prefix + $Line }
  $script:outputBox.AppendText($displayLine + [Environment]::NewLine)
  $script:outputBox.SelectionStart = $script:outputBox.TextLength
  $script:outputBox.ScrollToCaret()

  $preview = $Line
  if ($preview.Length -gt 100) { $preview = $preview.Substring(0, 97) + "…" }
  $script:latestOutput = $preview
  $script:latestOutputStream = $Stream
  $script:hasLatestOutput = $true
  Update-ElapsedStatus
}

function Format-Elapsed {
  param([Parameter(Mandatory = $true)][TimeSpan]$Elapsed)
  if ($Elapsed.TotalHours -ge 1) { return $Elapsed.ToString("h\:mm\:ss") }
  return $Elapsed.ToString("mm\:ss")
}

function Update-ElapsedStatus {
  if (-not $script:elapsedWatch) { return }
  $elapsedText = Format-Elapsed -Elapsed $script:elapsedWatch.Elapsed
  if (-not $script:hasLatestOutput) {
    $script:statusLabel.Text = "已运行 $elapsedText；等待程序输出。"
    return
  }
  $streamName = if ($script:latestOutputStream -eq "stderr") { "安装进度" } else { "运行输出" }
  $script:statusLabel.Text = "已运行 $elapsedText；最近$streamName：$($script:latestOutput)"
}

function Release-StartupMutex {
  if ($script:startupMutex) {
    if ($script:ownsStartupMutex) { $script:startupMutex.ReleaseMutex() }
    $script:ownsStartupMutex = $false
    $script:startupMutex.Dispose()
    $script:startupMutex = $null
  }
}

try {
  try {
    $startupMutex = New-Object -TypeName System.Threading.Mutex -ArgumentList @($false, $mutexName)
    $ownsStartupMutex = $startupMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $ownsStartupMutex = $true
  }

  if (-not $ownsStartupMutex) {
    [void][System.Windows.Forms.MessageBox]::Show(
      "已有 $productName 启动窗口正在运行或准备启动。请等待当前窗口完成后再重试。",
      $productName,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
    exit 0
  }

  $choice = [System.Windows.Forms.MessageBox]::Show(
    "是：启动或打开工作台`n否：停止工作台`n取消：退出",
    $productName,
    [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { exit 0 }

  $action = if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { "start" } else { "stop" }
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $productName
  $form.Width = 620
  $form.Height = 430
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.ControlBox = $false

  $statusLabel = New-Object System.Windows.Forms.Label
  $statusLabel.Text = if ($action -eq "start") {
    "首次启动会准备本机 Python/OCR；输出会实时显示在下方。"
  } else {
    "正在停止工作台及已识别的本机服务；输出会实时显示在下方。"
  }
  $statusLabel.AutoSize = $false
  $statusLabel.Left = 16
  $statusLabel.Top = 14
  $statusLabel.Width = 572
  $statusLabel.Height = 34
  $form.Controls.Add($statusLabel)

  $progress = New-Object System.Windows.Forms.ProgressBar
  $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
  $progress.MarqueeAnimationSpeed = 28
  $progress.Left = 16
  $progress.Top = 52
  $progress.Width = 572
  $progress.Height = 18
  $form.Controls.Add($progress)

  $outputBox = New-Object System.Windows.Forms.RichTextBox
  $outputBox.Multiline = $true
  $outputBox.ReadOnly = $true
  $outputBox.MaxLength = 0
  $outputBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $outputBox.WordWrap = $true
  $outputBox.Left = 16
  $outputBox.Top = 80
  $outputBox.Width = 572
  $outputBox.Height = 268
  $outputBox.Anchor = [System.Windows.Forms.AnchorStyles]::Top -bor [System.Windows.Forms.AnchorStyles]::Bottom -bor [System.Windows.Forms.AnchorStyles]::Left -bor [System.Windows.Forms.AnchorStyles]::Right
  $form.Controls.Add($outputBox)

  $outputBox.AppendText("安装日志：$installLogPath$([Environment]::NewLine)")
  $outputBox.AppendText("日志目录：$dataRoot$([Environment]::NewLine)$([Environment]::NewLine)")

  $openLogButton = New-Object System.Windows.Forms.Button
  $openLogButton.Text = "打开安装日志"
  $openLogButton.Left = 16
  $openLogButton.Top = 360
  $openLogButton.Width = 140
  $openLogButton.Height = 28
  $openLogButton.Enabled = [System.IO.Directory]::Exists($dataRoot)
  $openLogButton.Add_Click({
    try {
      if ([System.IO.File]::Exists($script:installLogPath)) {
        Invoke-Item -LiteralPath $script:installLogPath
      } elseif ([System.IO.Directory]::Exists($script:dataRoot)) {
        Invoke-Item -LiteralPath $script:dataRoot
      } else {
        [void][System.Windows.Forms.MessageBox]::Show(
          "安装日志目录尚未创建。",
          $script:productName,
          [System.Windows.Forms.MessageBoxButtons]::OK,
          [System.Windows.Forms.MessageBoxIcon]::Information
        )
      }
    } catch {
      [void][System.Windows.Forms.MessageBox]::Show(
        $_.Exception.Message,
        "无法打开安装日志",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Warning
      )
    }
  })
  $form.Controls.Add($openLogButton)

  $closeButton = New-Object System.Windows.Forms.Button
  $closeButton.Text = "关闭"
  $closeButton.Left = 508
  $closeButton.Top = 360
  $closeButton.Width = 80
  $closeButton.Height = 28
  $closeButton.Visible = $false
  $closeButton.Add_Click({ $script:form.Close() })
  $form.Controls.Add($closeButton)

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

  $stdoutTask = $process.StandardOutput.ReadLineAsync()
  $stderrTask = $process.StandardError.ReadLineAsync()
  $stdoutClosed = $false
  $stderrClosed = $false
  $latestOutput = ""
  $latestOutputStream = ""
  $hasLatestOutput = $false
  $elapsedWatch = [System.Diagnostics.Stopwatch]::StartNew()
  $lastStatusSecond = -1
  Update-ElapsedStatus
  $form.Show()

  while (-not ($process.HasExited -and $stdoutClosed -and $stderrClosed)) {
    [void][System.Windows.Forms.Application]::DoEvents()

    if (-not $stdoutClosed -and $stdoutTask.IsCompleted) {
      $line = $stdoutTask.GetAwaiter().GetResult()
      if ($null -eq $line) {
        $stdoutClosed = $true
      } else {
        Add-ProcessOutput -Stream "stdout" -Line $line
        $stdoutTask = $process.StandardOutput.ReadLineAsync()
      }
    }

    if (-not $stderrClosed -and $stderrTask.IsCompleted) {
      $line = $stderrTask.GetAwaiter().GetResult()
      if ($null -eq $line) {
        $stderrClosed = $true
      } else {
        Add-ProcessOutput -Stream "stderr" -Line $line
        $stderrTask = $process.StandardError.ReadLineAsync()
      }
    }

    if (-not $openLogButton.Enabled -and [System.IO.Directory]::Exists($dataRoot)) {
      $openLogButton.Enabled = $true
    }
    $elapsedSecond = [int][Math]::Floor($elapsedWatch.Elapsed.TotalSeconds)
    if ($elapsedSecond -ne $lastStatusSecond) {
      Update-ElapsedStatus
      $lastStatusSecond = $elapsedSecond
    }
    Start-Sleep -Milliseconds 50
  }

  $process.WaitForExit()
  $exitCode = $process.ExitCode
  $elapsedWatch.Stop()
  $elapsedText = Format-Elapsed -Elapsed $elapsedWatch.Elapsed
  Release-StartupMutex
  $progress.Visible = $false
  $statusLabel.Text = if ($exitCode -eq 0) {
    "操作已完成（已用 $elapsedText）。输出和安装日志路径已保留在此窗口中。"
  } else {
    "操作未完成（退出代码 $exitCode，已用 $elapsedText）；完整错误输出保留在下方，可打开安装日志查看详情。"
  }
  $closeButton.Visible = $true
  $form.ControlBox = $true

  while ($form.Visible) {
    [void][System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
  }

  exit $exitCode
} catch {
  if ($form -and -not $form.IsDisposed) { $form.Close() }
  [void][System.Windows.Forms.MessageBox]::Show(
    $_.Exception.Message,
    "操作未完成",
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
  exit 1
} finally {
  if ($process) { $process.Dispose() }
  Release-StartupMutex
}
