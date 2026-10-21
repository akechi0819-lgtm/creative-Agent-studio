param(
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [Parameter(Mandatory = $true)][ValidateSet('general', 'company')][string]$Profile,
  [Parameter(Mandatory = $true)][string]$DataDirectory,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory,
  [ValidateSet('start', 'stop', 'configure')][string]$Action = 'start',
  [switch]$WarmStart,
  [string]$ConfigurationScript,
  [string]$ConfigurationNode,
  [switch]$ResumeConfiguration,
  [ValidateRange(30, 7200)][int]$TimeoutSeconds = 2400
)

$ErrorActionPreference = 'Stop'

foreach ($pathValue in @($PackageRoot, $DataDirectory, $EvidenceDirectory)) {
  if ([string]::IsNullOrWhiteSpace($pathValue)) { throw 'PackageRoot、DataDirectory、EvidenceDirectory 必须是非空路径。' }
}
if ($WarmStart -and $Action -ne 'start') { throw '-WarmStart 只能与 -Action start 一起使用。' }
if ($ResumeConfiguration -and $Action -ne 'configure') { throw '-ResumeConfiguration 只能与 -Action configure 一起使用。' }

function Resolve-FullPath {
  param([Parameter(Mandatory = $true)][string]$Value)
  return [System.IO.Path]::GetFullPath($Value)
}

function Test-PathWithin {
  param([string]$Parent, [string]$Candidate)
  $separators = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
  $prefix = $Parent.TrimEnd($separators) + [System.IO.Path]::DirectorySeparatorChar
  return $Candidate.Equals($Parent, [System.StringComparison]::OrdinalIgnoreCase) -or $Candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Write-Evidence {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)]$Value)
  $json = ConvertTo-Json -InputObject $Value -Depth 10
  $encoding = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $encoding)
}

function Get-WindowElements {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $found = New-Object System.Collections.ArrayList
  foreach ($item in $items) {
    try {
      if ($item.Current.ProcessId -eq $ProcessId -and $item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
        [void]$found.Add($item)
      }
    } catch { }
  }
  return ,$found.ToArray()
}

function Get-WindowSnapshot {
  param([Parameter(Mandatory = $true)]$Window)
  $controls = New-Object System.Collections.ArrayList
  $text = New-Object System.Collections.ArrayList
  try { [void]$text.Add($Window.Current.Name) } catch { }
  try {
    $items = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $items) {
      try {
        $current = $item.Current
        $entry = [ordered]@{
          name = $current.Name
          automationId = $current.AutomationId
          controlType = $current.ControlType.ProgrammaticName
          className = $current.ClassName
          processId = $current.ProcessId
          enabled = $current.IsEnabled
          offscreen = $current.IsOffscreen
        }
        [void]$controls.Add($entry)
        if (-not [string]::IsNullOrWhiteSpace($current.Name)) { [void]$text.Add($current.Name) }
        if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -and $current.ClassName -notmatch 'RichEdit') {
          try {
            $pattern = $item.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $value = $pattern.Current.Value
            if (-not [string]::IsNullOrWhiteSpace($value)) { [void]$text.Add($value) }
          } catch { }
        }
      } catch { }
    }
  } catch { }
  return [pscustomobject]@{
    processId = $Window.Current.ProcessId
    nativeWindowHandle = $Window.Current.NativeWindowHandle
    name = $Window.Current.Name
    text = (($text.ToArray() | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n")
    controls = @($controls.ToArray())
  }
}

function Get-VisibleEditText {
  param([Parameter(Mandatory = $true)]$Window)
  $items = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($item in $items) {
    try {
      if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -and $item.Current.ClassName -notmatch 'RichEdit') { continue }
      $pattern = $item.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
      $ranges = $pattern.GetVisibleRanges()
      $visibleText = New-Object System.Collections.ArrayList
      foreach ($range in $ranges) {
        $part = $range.GetText(-1)
        if (-not [string]::IsNullOrWhiteSpace($part)) { [void]$visibleText.Add($part) }
      }
      return [pscustomobject]@{
        element = $item
        className = $item.Current.ClassName
        text = $visibleText.ToArray() -join "`n"
        visibleRangeCount = $ranges.Count
      }
    } catch { }
  }
  return $null
}

function Get-WindowButtons {
  param([Parameter(Mandatory = $true)]$Window)
  $items = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $buttons = New-Object System.Collections.ArrayList
  foreach ($item in $items) {
    try {
      if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { [void]$buttons.Add($item) }
    } catch { }
  }
  return ,$buttons.ToArray()
}

function Get-ConsoleWindowKey {
  param([Parameter(Mandatory = $true)]$Window)
  return '{0}:{1}:{2}' -f $Window.ProcessId, $Window.Handle.ToInt64().ToString('X'), $Window.ClassName
}

function Convert-ConsoleWindowEvidence {
  param([Parameter(Mandatory = $true)]$Window)
  return [pscustomobject]@{
    handle = '0x' + $Window.Handle.ToInt64().ToString('X')
    processId = [int]$Window.ProcessId
    className = $Window.ClassName
    title = $Window.Title
    visible = [bool]$Window.Visible
  }
}

function Start-ConsoleWindowMonitor {
  $script:consoleBaselineKeys = @{}
  $script:consoleViolations = New-Object System.Collections.ArrayList
  $windows = @([WindowsLauncherEvidence.NativeWindow]::GetConsoleWindows() | Where-Object { $_.Visible })
  foreach ($window in $windows) { $script:consoleBaselineKeys[(Get-ConsoleWindowKey -Window $window)] = $true }
  if ($Action -eq 'configure') {
    $script:consoleBaseline = @($windows | ForEach-Object { [pscustomobject]@{ className = $_.ClassName; visible = [bool]$_.Visible } })
  } else {
    $script:consoleBaseline = @($windows | ForEach-Object { Convert-ConsoleWindowEvidence -Window $_ })
  }
  $script:consoleMonitorLastCheckedAt = [DateTime]::UtcNow
  $script:consoleLastPollAt = $script:consoleMonitorLastCheckedAt
  $script:consoleMonitoringStarted = $true
  $script:baseEvidence.consoleWindowMonitor = [ordered]@{
    observedClasses = @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS')
    baselineCapturedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
    baselineWindows = $script:consoleBaseline
    pollingIntervalMs = 50
    maximumObservedPollGapMs = 0
    scope = 'only windows observed during this GUI test; existing handles were captured before launch and excluded'
  }
}

function Save-ConsoleWindowScreenshot {
  param([Parameter(Mandatory = $true)]$Window)
  $bounds = [WindowsLauncherEvidence.NativeWindow]::GetBounds($Window.Handle)
  $width = [int]$bounds.Width
  $height = [int]$bounds.Height
  if ($width -lt 1 -or $height -lt 1) { throw '新增控制台窗口尺寸无效。' }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen([int]$bounds.Left, [int]$bounds.Top, 0, 0, [System.Drawing.Size]::new($width, $height))
    $path = Join-Path $script:evidenceDirectory ("{0}-unexpected-console-pid{1}-hwnd{2}.png" -f $script:evidenceRunId, $Window.ProcessId, $Window.Handle.ToInt64().ToString('X'))
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Assert-NoNewConsoleWindows {
  if (-not $script:consoleMonitoringStarted) { return }
  $script:consoleMonitorLastCheckedAt = [DateTime]::UtcNow
  $pollGapMs = [Math]::Round(($script:consoleMonitorLastCheckedAt - $script:consoleLastPollAt).TotalMilliseconds, 3)
  if ($pollGapMs -gt $script:baseEvidence.consoleWindowMonitor.maximumObservedPollGapMs) {
    $script:baseEvidence.consoleWindowMonitor.maximumObservedPollGapMs = $pollGapMs
  }
  $script:consoleLastPollAt = $script:consoleMonitorLastCheckedAt
  $windows = @([WindowsLauncherEvidence.NativeWindow]::GetConsoleWindows())
  $currentKeys = @{}
  foreach ($window in $windows) { $currentKeys[(Get-ConsoleWindowKey -Window $window)] = $true }
  foreach ($key in @($script:consoleBaselineKeys.Keys)) {
    if (-not $currentKeys.ContainsKey($key)) { [void]$script:consoleBaselineKeys.Remove($key) }
  }
  foreach ($window in $windows) {
    $key = Get-ConsoleWindowKey -Window $window
    if (-not $window.Visible -or $script:consoleBaselineKeys.ContainsKey($key)) { continue }
    $evidence = [ordered]@{
      detectedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
      handle = '0x' + $window.Handle.ToInt64().ToString('X')
      processId = [int]$window.ProcessId
      className = $window.ClassName
      screenshot = $null
    }
    if ($Action -ne 'configure') { $evidence.title = $window.Title }
    try {
      $evidence.screenshot = Save-ConsoleWindowScreenshot -Window $window
      [void]$script:screenshots.Add($evidence.screenshot)
    } catch { $evidence.screenshotError = $_.Exception.Message }
    [void]$script:consoleViolations.Add($evidence)
    $script:baseEvidence.consoleWindowMonitor.observedViolations = @($script:consoleViolations.ToArray())
    $details = "class=$($window.ClassName), hwnd=0x$($window.Handle.ToInt64().ToString('X')), pid=$($window.ProcessId)"
    if ($Action -ne 'configure') { $details += ", title=$($window.Title)" }
    throw "观察到启动后新增的可见控制台窗口（$details）；黑窗证据已记录。"
  }
}

function Find-Button {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [string]$AutomationId,
    [string[]]$Names = @()
  )
  $buttons = Get-WindowButtons -Window $Window
  if (-not [string]::IsNullOrEmpty($AutomationId)) {
    foreach ($button in $buttons) {
      try {
        if ($button.Current.AutomationId -eq $AutomationId -and $button.Current.IsEnabled -and -not $button.Current.IsOffscreen) { return $button }
      } catch { }
    }
  }
  foreach ($button in $buttons) {
    try {
      if ($Names -contains $button.Current.Name -and $button.Current.IsEnabled -and -not $button.Current.IsOffscreen) { return $button }
    } catch { }
  }
  return $null
}

function Invoke-Button {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [string]$AutomationId,
    [string[]]$Names = @(),
    [Parameter(Mandatory = $true)][string]$Description
  )
  $button = Find-Button -Window $Window -AutomationId $AutomationId -Names $Names
  if (-not $button) {
    $snapshot = Get-WindowSnapshot -Window $Window
    throw "未找到可点击的真实 UIA 按钮：$Description。窗口控件：$(ConvertTo-Json -InputObject $snapshot.controls -Compress -Depth 5)"
  }
  $result = [pscustomobject]@{
    name = $button.Current.Name
    automationId = $button.Current.AutomationId
    processId = $button.Current.ProcessId
  }
  $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  return $result
}

function Get-DescendantPowerShell {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$HostProcess, [Parameter(Mandatory = $true)][DateTime]$Deadline)
  $scriptPath = Join-Path $script:packageRoot 'release\windows-start.ps1'
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    $HostProcess.Refresh()
    if ($HostProcess.HasExited) { throw "VBS 启动宿主已提前退出，exit=$($HostProcess.ExitCode)。" }
    $children = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($HostProcess.Id)" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      if ($child.Name -match '^powershell(\.exe)?$' -and $child.CommandLine -and $child.CommandLine.IndexOf($scriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return [int]$child.ProcessId
      }
    }
    Start-Sleep -Milliseconds 50
  }
  throw "超时：找不到由 VBS $($HostProcess.Id) 启动的 Windows PowerShell 进程。"
}

function Start-VbsLauncher {
  param([Parameter(Mandatory = $true)][string]$EntryPath, [Parameter(Mandatory = $true)][DateTime]$Deadline)
  $wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $wscript
  $info.Arguments = "//nologo `"$EntryPath`""
  $info.WorkingDirectory = $script:packageRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

  $environment = $info.EnvironmentVariables
  foreach ($key in @($environment.Keys)) {
    if ($key -match '(?i)(API[_-]?KEY|ACCESS[_-]?TOKEN|PASSWORD|SECRET|TEEDY|^TEST_|^CAS_)' -or $key -eq 'STUDIO_RELEASE_NO_OPEN' -or $key -eq 'STUDIO_COMPANY_SERVICES_FILE') {
      [void]$environment.Remove($key)
    }
  }
  $environment['STUDIO_DATA_DIR'] = $script:dataDirectory
  $environment['UV_CACHE_DIR'] = Join-Path $script:dataDirectory 'uv-cache'

  $hostProcess = [System.Diagnostics.Process]::Start($info)
  $childProcessId = Get-DescendantPowerShell -HostProcess $hostProcess -Deadline $Deadline
  return [pscustomobject]@{ host = $hostProcess; powerShellPid = $childProcessId }
}

function Wait-Window {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][ValidateSet('choice', 'duplicate', 'progress', 'completion')][string]$Kind,
    [Parameter(Mandatory = $true)][DateTime]$Deadline
  )
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    foreach ($window in (Get-WindowElements -ProcessId $ProcessId)) {
      try {
        $snapshot = Get-WindowSnapshot -Window $window
        $buttons = Get-WindowButtons -Window $window
        $ids = @($buttons | ForEach-Object { $_.Current.AutomationId })
        $names = @($buttons | ForEach-Object { $_.Current.Name })
        $matches = $false
        switch ($Kind) {
          'choice' {
            $matches = ($ids -contains '6' -or $names -contains 'Yes' -or $names -contains '是') -and ($ids -contains '7' -or $names -contains 'No' -or $names -contains '否')
          }
          'duplicate' {
            $matches = $snapshot.text.Contains('已有') -and ($ids -contains '1' -or $names -contains 'OK' -or $names -contains '确定')
          }
          'progress' {
            $hasLogButton = $null -ne (Find-Button -Window $window -AutomationId '' -Names @('打开安装日志'))
            $hasEdit = @($snapshot.controls | Where-Object { $_.controlType -eq 'ControlType.Edit' -or $_.className -match 'RichEdit' }).Count -gt 0
            $matches = $snapshot.name -eq $script:productName -and $hasLogButton -and $hasEdit
          }
          'completion' {
            $completed = $snapshot.text.Contains('操作已完成') -or $snapshot.text.Contains('操作未完成')
            $matches = $snapshot.name -eq $script:productName -and $completed -and ($names -contains '关闭')
          }
        }
        if ($matches) { return $window }
      } catch { }
    }
    Start-Sleep -Milliseconds 50
  }
  throw "超时：未找到进程 $ProcessId 的 $Kind 窗口。"
}

function Wait-ProcessExit {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process, [Parameter(Mandatory = $true)][DateTime]$Deadline)
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    $Process.Refresh()
    if ($Process.HasExited) { return $Process.ExitCode }
    Start-Sleep -Milliseconds 50
  }
  throw "超时：进程 $($Process.Id) 尚未退出。"
}

function Save-WindowScreenshot {
  param([Parameter(Mandatory = $true)]$Window, [Parameter(Mandatory = $true)][string]$Name)
  $handle = [IntPtr]$Window.Current.NativeWindowHandle
  if ($handle -eq [IntPtr]::Zero) { throw "窗口没有 NativeWindowHandle，无法保存 $Name 截图。" }
  $bounds = $Window.Current.BoundingRectangle
  $left = [int][Math]::Floor($bounds.X)
  $top = [int][Math]::Floor($bounds.Y)
  $width = [int][Math]::Ceiling($bounds.Width)
  $height = [int][Math]::Ceiling($bounds.Height)
  if ($width -lt 1 -or $height -lt 1) { throw "窗口尺寸无效，无法保存 $Name 截图。" }
  [void][WindowsLauncherEvidence.NativeWindow]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 150
  if ([WindowsLauncherEvidence.NativeWindow]::GetForegroundWindow() -ne $handle) {
    throw "窗口没有成为前台窗口，拒绝保存可能错误的 $Name 截图。"
  }
  $bitmap = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($left, $top, 0, 0, [System.Drawing.Size]::new($width, $height))
    $path = Join-Path $script:evidenceDirectory "$($script:evidenceRunId)-$Name"
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    return $path
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Get-PythonReadinessSnapshot {
  $stateRoot = Join-Path $script:dataDirectory 'runtime\.studio-runtime'
  $runtime = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $stateRoot 'python-runtime-state.json') -Raw | ConvertFrom-Json
  $dependencies = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $stateRoot 'python-state.json') -Raw | ConvertFrom-Json
  $models = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $stateRoot 'rapidocr-model-state.json') -Raw | ConvertFrom-Json
  if ($runtime.status -ne 'ready' -or $dependencies.status -ne 'ready' -or $models.status -ne 'ready') {
    throw 'WarmStart 前后 Python、依赖和 OCR 模型状态都必须保持 ready。'
  }
  if ([string]$dependencies.fingerprint -notmatch '^[a-f0-9]{64}$' -or
      [string]$models.fingerprint -notmatch '^[a-f0-9]{64}$' -or
      [string]::IsNullOrWhiteSpace([string]$runtime.pythonExecutable) -or
      [string]::IsNullOrWhiteSpace([string]$models.modelRoot)) {
    throw 'WarmStart 状态缺少依赖指纹、模型指纹、Python 虚拟环境路径或模型缓存路径。'
  }
  $modelFiles = @(
    $models.files | ForEach-Object {
      if ([string]::IsNullOrWhiteSpace([string]$_.path) -or [long]$_.size -le 0 -or [string]$_.sha256 -notmatch '^[a-f0-9]{64}$') {
        throw 'WarmStart 模型缓存清单包含无效文件或 SHA-256。'
      }
      [pscustomobject]@{ path = [string]$_.path; size = [long]$_.size; sha256 = ([string]$_.sha256).ToLowerInvariant() }
    } | Sort-Object -Property path
  )
  if ($modelFiles.Count -lt 2) { throw 'WarmStart 状态没有至少两个已核验的 OCR 模型缓存文件。' }
  return [ordered]@{
    python = [ordered]@{
      status = [string]$runtime.status
      executable = [string]$runtime.pythonExecutable
      version = [string]$runtime.pythonVersion
      basePrefix = [string]$runtime.basePrefix
    }
    dependencies = [ordered]@{
      status = [string]$dependencies.status
      fingerprint = ([string]$dependencies.fingerprint).ToLowerInvariant()
      pythonVersion = [string]$dependencies.pythonVersion
    }
    models = [ordered]@{
      status = [string]$models.status
      fingerprint = ([string]$models.fingerprint).ToLowerInvariant()
      root = [string]$models.modelRoot
      files = @($modelFiles)
    }
  }
}

function Assert-ProgressWindow {
  param([Parameter(Mandatory = $true)]$Window, [string]$ExpectedLogPath = '')
  $snapshot = Get-WindowSnapshot -Window $Window
  $openLogButton = Find-Button -Window $Window -AutomationId '' -Names @('打开安装日志')
  if (-not $openLogButton -or -not $openLogButton.Current.IsEnabled) { throw '真实进度窗口的“打开安装日志”按钮缺失或不可用。' }
  $edit = $null
  $dataDirectoryLineVerified = $false
  $items = $Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($item in $items) {
    try {
      if ($item.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -or $item.Current.ClassName -match 'RichEdit') {
        $pattern = $item.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
        $dataDirectoryLine = $pattern.DocumentRange.FindText("日志目录：$script:dataDirectory", $false, $false)
        if ($null -eq $dataDirectoryLine) { continue }
        $dataDirectoryLineVerified = $true
        if (-not [string]::IsNullOrWhiteSpace($ExpectedLogPath)) {
          $logLine = $pattern.DocumentRange.FindText("安装日志：$ExpectedLogPath", $false, $false)
          if ($null -ne $logLine) { $edit = $item; break }
        } else {
          $documentText = $pattern.DocumentRange.GetText(-1)
          if (-not [string]::IsNullOrWhiteSpace($documentText)) { $edit = $item; break }
        }
      }
    } catch { }
  }
  if (-not $edit) {
    if (-not $dataDirectoryLineVerified) { throw '真实 RichText 控件未显示隔离数据目录的完整路径。' }
    if ([string]::IsNullOrWhiteSpace($ExpectedLogPath)) {
      throw '真实滚动文本控件没有提供可读的 TextPattern 正文。'
    }
    throw '真实滚动文本控件未显示本次 Python 安装日志路径，或没有提供可读的 TextPattern 正文。'
  }
  $visibleEdit = Get-VisibleEditText -Window $Window
  $scrollable = $false
  try {
    $scroll = $edit.GetCurrentPattern([System.Windows.Automation.ScrollPattern]::Pattern)
    $scrollable = $scroll.Current.VerticallyScrollable
    if ($scrollable) {
      $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallIncrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
      $scroll.Scroll([System.Windows.Automation.ScrollAmount]::SmallDecrement, [System.Windows.Automation.ScrollAmount]::NoAmount)
    }
  } catch { }
  $scrollbars = @($Window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::ScrollBar }).Count
  if (-not $scrollable -and $scrollbars -eq 0 -and $edit.Current.ClassName -notmatch 'RichEdit') {
    throw '进度输出控件没有可验证的滚动能力。'
  }
  return [pscustomobject]@{
    windowText = $snapshot.text
    dataDirectoryLineVerified = $dataDirectoryLineVerified
    textControlClass = $edit.Current.ClassName
    hasTextPattern = $true
    visibleText = if ($visibleEdit) { $visibleEdit.text } else { '' }
    visibleRangeCount = if ($visibleEdit) { $visibleEdit.visibleRangeCount } else { 0 }
    expectedLogPathVerified = -not [string]::IsNullOrWhiteSpace($ExpectedLogPath)
    verticallyScrollable = $scrollable
    scrollbarControls = $scrollbars
    logButtonEnabled = $openLogButton.Current.IsEnabled
  }
}

function Wait-ProgressText {
  param(
    [Parameter(Mandatory = $true)]$Window,
    [Parameter(Mandatory = $true)][string]$ExpectedLogPath,
    [Parameter(Mandatory = $true)][DateTime]$Deadline,
    [switch]$WarmStart
  )
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    try {
      $snapshot = Get-WindowSnapshot -Window $Window
      $editText = Get-VisibleEditText -Window $Window
      $streamMarker = '[安装进度]'
      $actualProgress = $editText -and $editText.text.Contains($streamMarker)
      $actualTime = $snapshot.text -match '已运行\s+\d{2}:\d{2}'
      if ($actualProgress -and $actualTime) {
        return [pscustomobject]@{ text = $snapshot.text; visibleOutputText = $editText.text; visibleRangeCount = $editText.visibleRangeCount; outputVisible = $actualProgress; outputStreamMarker = $streamMarker; elapsedStatusVisible = $actualTime }
      }
    } catch { }
    Start-Sleep -Milliseconds 100
  }
  throw '超时：实时 UIA 文本中没有同时出现 Python 安装进度与运行耗时。'
}

function Wait-Completion {
  param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][DateTime]$Deadline)
  return Wait-Window -ProcessId $ProcessId -Kind completion -Deadline $Deadline
}

function Get-RuntimeRecord {
  $runtimePath = Join-Path $script:dataDirectory 'web\runtime.json'
  if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { return $null }
  try { return Get-Content -Encoding UTF8 -LiteralPath $runtimePath -Raw | ConvertFrom-Json }
  catch { return $null }
}

function Test-ControlHealth {
  param([Parameter(Mandatory = $true)]$Record)
  Assert-NoNewConsoleWindows
  $headers = @{ Authorization = "Bearer $($Record.token)" }
  $response = Invoke-WebRequest -Uri "$($Record.controlUrl)/health" -Headers $headers -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
  $body = $response.Content | ConvertFrom-Json
  if ($response.StatusCode -ne 200 -or $body.instanceId -ne $Record.instanceId) { throw '本机工作台控制健康身份不匹配。' }
  $page = Invoke-WebRequest -Uri $Record.url -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  Assert-NoNewConsoleWindows
  if ($page.StatusCode -ne 200) { throw "工作台页面 HTTP 状态为 $($page.StatusCode)。" }
  return [pscustomobject]@{ controlStatus = [int]$response.StatusCode; pageStatus = [int]$page.StatusCode; instanceMatches = $true }
}

function Wait-RuntimeHealthy {
  param([Parameter(Mandatory = $true)][DateTime]$Deadline)
  $lastError = '尚未写入 web/runtime.json。'
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    $record = Get-RuntimeRecord
    if ($record) {
      try {
        $health = Test-ControlHealth -Record $record
        return [pscustomobject]@{ record = $record; health = $health }
      } catch {
        if ($script:consoleViolations.Count -gt 0) { throw }
        $lastError = $_.Exception.Message
      }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "工作台未在超时前通过本机控制与页面健康检查：$lastError"
}

function Wait-RuntimeStopped {
  param([Parameter(Mandatory = $true)]$Record, [Parameter(Mandatory = $true)][DateTime]$Deadline)
  $runtimePath = Join-Path $script:dataDirectory 'web\runtime.json'
  while ([DateTime]::UtcNow -lt $Deadline) {
    Assert-NoNewConsoleWindows
    $recordStillThere = Test-Path -LiteralPath $runtimePath -PathType Leaf
    $healthy = $false
    try { [void](Test-ControlHealth -Record $Record); $healthy = $true } catch {
      if ($script:consoleViolations.Count -gt 0) { throw }
    }
    if (-not $recordStillThere -and -not $healthy) { return }
    Start-Sleep -Milliseconds 500
  }
  throw '停止窗口已结束，但工作台控制健康仍在或 runtime.json 尚未移除。'
}

function Save-LaunchEvidence {
  param([Parameter(Mandatory = $true)][string]$Name, [Parameter(Mandatory = $true)]$Value)
  $path = Join-Path $script:evidenceDirectory $Name
  Write-Evidence -Path $path -Value $Value
  return $path
}

function Get-LaunchEvidenceName {
  if ($Action -eq 'configure') {
    $suffix = if ($ResumeConfiguration) { 'resume' } else { 'first-run' }
    return "launcher-configure-$Profile-$suffix.json"
  }
  if ($Action -eq 'stop') { return 'launcher-stop.json' }
  if ($WarmStart) { return 'launcher-warm-start.json' }
  return 'launcher-start.json'
}

function Quote-ProcessArgument {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.Append([char]34)
  $slashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq [char]92) { $slashes++; continue }
    if ($character -eq [char]34) {
      if ($slashes -gt 0) { [void]$builder.Append([char]92, [int]($slashes * 2)) }
      [void]$builder.Append([char]92)
      [void]$builder.Append([char]34)
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$builder.Append([char]92, $slashes); $slashes = 0 }
    [void]$builder.Append($character)
  }
  if ($slashes -gt 0) { [void]$builder.Append([char]92, [int]($slashes * 2)) }
  [void]$builder.Append([char]34)
  return $builder.ToString()
}

function Stop-ConfigurationProcessTree {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  try {
    $taskkill = Join-Path $env:WINDIR 'System32\taskkill.exe'
    $killInfo = New-Object System.Diagnostics.ProcessStartInfo
    $killInfo.FileName = $taskkill
    $killInfo.Arguments = "/PID $($Process.Id) /T /F"
    $killInfo.UseShellExecute = $false
    $killInfo.CreateNoWindow = $true
    $killInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $killInfo.RedirectStandardOutput = $true
    $killInfo.RedirectStandardError = $true
    $killer = [System.Diagnostics.Process]::Start($killInfo)
    if ($killer) {
      if (-not $killer.WaitForExit(10000)) { try { $killer.Kill() } catch { } }
      $killer.Dispose()
    }
  } catch { }
  try {
    $Process.Refresh()
    if (-not $Process.HasExited) {
      $Process.Kill()
      [void]$Process.WaitForExit(10000)
    }
  } catch { }
}

function Sanitize-ConfigurationOutputLine {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Line)
  $safe = [regex]::Replace($Line, '(?i)(\bBearer\s+)[^\s,;"'']+', '$1<redacted>')
  foreach ($value in $script:configurationRedactions) {
    if ($value.Length -ge 4) {
      $safe = [regex]::Replace($safe, [regex]::Escape($value), '<fixture-redacted>', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    }
  }
  return $safe
}

function Invoke-ConfigurationNode {
  param([Parameter(Mandatory = $true)][DateTime]$Deadline)
  $arguments = @(
    $script:configurationScript,
    '--package-root', $script:packageRoot,
    '--profile', $Profile,
    '--data-dir', $script:dataDirectory,
    '--evidence-dir', $script:configurationEvidenceDirectory
  )
  if ($ResumeConfiguration) { $arguments += '--resume' }
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $script:configurationNode
  $info.Arguments = (($arguments | ForEach-Object { Quote-ProcessArgument -Value ([string]$_) }) -join ' ')
  $info.WorkingDirectory = Split-Path -Parent $script:configurationScript
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $info.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $sourceText = Get-Content -Encoding UTF8 -LiteralPath $script:configurationScript -Raw
  $script:configurationRedactions = @(
    [regex]::Matches($sourceText, "(?m)^\s*const\s+[A-Z][A-Z0-9_]*\s*=\s*'([^']*)';") |
      ForEach-Object { $_.Groups[1].Value } | Where-Object { -not [string]::IsNullOrEmpty($_) }
  )
  $environment = $info.EnvironmentVariables
  foreach ($key in @($environment.Keys)) {
    if ($key -match '(?i)(API[_-]?KEY|TOKEN|PASSWORD|SECRET|TEEDY|^TEST_|^CAS_)' -or
        $key -eq 'STUDIO_RELEASE_NO_OPEN' -or $key -eq 'STUDIO_COMPANY_SERVICES_FILE') {
      [void]$environment.Remove($key)
    }
  }
  $environment['STUDIO_DATA_DIR'] = $script:dataDirectory
  $environment['STUDIO_RELEASE_NO_OPEN'] = '1'
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  if (-not $process.Start()) { throw '无法启动 Windows first-config Node 验证进程。' }
  $script:baseEvidence.configurationProcessId = $process.Id
  $phaseName = if ($ResumeConfiguration) { 'resume' } else { 'first-run' }
  $diagnosticName = "configuration-$phaseName-diagnostic.txt"
  $diagnosticPath = Join-Path $script:configurationEvidenceDirectory $diagnosticName
  $diagnosticRelativePath = "first-config-$Profile/$diagnosticName"
  $script:baseEvidence.configurationDiagnostic = $diagnosticRelativePath
  $stdoutLines = 0
  $stderrLines = 0
  $successSummary = ''
  $diagnostics = [System.Text.StringBuilder]::new()
  $stdoutTask = $process.StandardOutput.ReadLineAsync()
  $stderrTask = $process.StandardError.ReadLineAsync()
  try {
    while ($true) {
      Assert-NoNewConsoleWindows
      if ($stdoutTask -and $stdoutTask.IsCompleted) {
        $line = $stdoutTask.GetAwaiter().GetResult()
        if ($null -eq $line) { $stdoutTask = $null } else {
          $stdoutLines++
          $safeLine = Sanitize-ConfigurationOutputLine -Line $line
          [void]$diagnostics.AppendLine("[stdout] $safeLine")
          [Console]::Out.WriteLine("[configuration stdout] $safeLine")
          $expectedPrefix = if ($ResumeConfiguration) { "Windows restart UI smoke passed for profile ${Profile}:" } else { "Windows first-run UI smoke passed for profile ${Profile}:" }
          if ($line.StartsWith($expectedPrefix, [System.StringComparison]::Ordinal)) {
            $successSummary = $safeLine
          }
          $stdoutTask = $process.StandardOutput.ReadLineAsync()
        }
      }
      if ($stderrTask -and $stderrTask.IsCompleted) {
        $line = $stderrTask.GetAwaiter().GetResult()
        if ($null -eq $line) { $stderrTask = $null } else {
          $stderrLines++
          $safeLine = Sanitize-ConfigurationOutputLine -Line $line
          [void]$diagnostics.AppendLine("[stderr] $safeLine")
          [Console]::Out.WriteLine("[configuration stderr] $safeLine")
          $stderrTask = $process.StandardError.ReadLineAsync()
        }
      }
      if ($process.HasExited -and -not $stdoutTask -and -not $stderrTask) { break }
      if ([DateTime]::UtcNow -ge $Deadline) {
        Stop-ConfigurationProcessTree -Process $process
        $tail = @($diagnostics.ToString() -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 30) -join [Environment]::NewLine
        throw "Windows first-config Node 验证超过时限；sanitized diagnostic 尾部：`n$tail"
      }
      Start-Sleep -Milliseconds 100
    }
    $process.WaitForExit()
    $script:baseEvidence.stdoutLines = $stdoutLines
    $script:baseEvidence.stderrLines = $stderrLines
    if ($process.ExitCode -ne 0) {
      $tail = @($diagnostics.ToString() -split "`r?`n" | Where-Object { $_ } | Select-Object -Last 30) -join [Environment]::NewLine
      throw "Windows first-config Node 验证退出代码为 $($process.ExitCode)；sanitized diagnostic 尾部：`n$tail"
    }
    if ([string]::IsNullOrWhiteSpace($successSummary)) { throw 'Windows first-config Node 验证未输出预期成功标记；sanitized diagnostic 已保留。' }
    return [pscustomobject]@{ processId = $process.Id; exitCode = $process.ExitCode; stdoutLines = $stdoutLines; stderrLines = $stderrLines; successSummary = $successSummary; diagnostic = $diagnosticRelativePath }
  } finally {
    $process.Refresh()
    if (-not $process.HasExited) { Stop-ConfigurationProcessTree -Process $process }
    $process.Dispose()
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($diagnosticPath, $diagnostics.ToString(), $encoding)
  }
}

if ($env:OS -ne 'Windows_NT' -or [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Windows GUI 启动验证必须在 Windows 主机运行；当前主机不支持 Win32 VBS/UIAutomation。'
}
if (-not [Environment]::UserInteractive) { throw 'Windows runner 没有交互式桌面；本次 GUI 验证明确失败。' }

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Drawing.dll') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
namespace WindowsLauncherEvidence {
  public class ConsoleWindowInfo {
    public IntPtr Handle;
    public uint ProcessId;
    public string ClassName;
    public string Title;
    public bool Visible;
  }
  public static class NativeWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint="GetClassNameW", ExactSpelling=true, CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder name, int maxCount);
    [DllImport("user32.dll", EntryPoint="GetWindowTextW", ExactSpelling=true, CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", SetLastError=true)] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll")] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", EntryPoint="GetUserObjectInformationW", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, uint length, out uint needed);
    private static string GetUserObjectName(IntPtr handle) {
      if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      StringBuilder name = new StringBuilder(256);
      uint needed;
      if (!GetUserObjectInformation(handle, 2, name, (uint)(name.Capacity * 2), out needed))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return name.ToString();
    }
    public static string GetCurrentDesktopPath() {
      IntPtr station = GetProcessWindowStation();
      IntPtr desktop = GetThreadDesktop(GetCurrentThreadId());
      return GetUserObjectName(station) + "\\" + GetUserObjectName(desktop);
    }
    public static ConsoleWindowInfo[] GetConsoleWindows() {
      List<ConsoleWindowInfo> windows = new List<ConsoleWindowInfo>();
      bool enumerated = EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        StringBuilder className = new StringBuilder(256);
        if (GetClassName(hWnd, className, className.Capacity) <= 0) return true;
        string classText = className.ToString();
        if (classText == "ConsoleWindowClass" || classText == "CASCADIA_HOSTING_WINDOW_CLASS") {
          uint processId;
          GetWindowThreadProcessId(hWnd, out processId);
          StringBuilder title = new StringBuilder(512);
          GetWindowText(hWnd, title, title.Capacity);
          windows.Add(new ConsoleWindowInfo {
            Handle = hWnd,
            ProcessId = processId,
            ClassName = classText,
            Title = title.ToString(),
            Visible = IsWindowVisible(hWnd)
          });
        }
        return true;
      }, IntPtr.Zero);
      if (!enumerated) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return windows.ToArray();
    }
    public static Rectangle GetBounds(IntPtr hWnd) {
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
    }
  }
}
'@
} catch {
  throw "Windows UIAutomation/WinForms 无法初始化，不能用源码或跳过路径代替真实 UI 验证：$($_.Exception.Message)"
}

$script:packageRoot = Resolve-FullPath -Value $PackageRoot
$script:evidenceDirectory = Resolve-FullPath -Value $EvidenceDirectory
$script:dataDirectory = Resolve-FullPath -Value $DataDirectory
$script:productName = if ($Profile -eq 'company') { 'Creative Agent Studio Company' } else { 'Creative Agent Studio' }
$script:entryPath = Join-Path $script:packageRoot $(if ($Profile -eq 'company') { 'Start-Company.vbs' } else { 'Start.vbs' })
$script:nodePath = Join-Path $script:packageRoot '.studio-runtime\node\node-v22.23.3-win-x64\node.exe'
$script:launcherScript = Join-Path $script:packageRoot 'release\windows-start.ps1'
$script:installLogPath = Join-Path $script:dataDirectory 'python-prepare.log'
$script:runStartedAt = [DateTime]::UtcNow
$script:evidenceRunId = '{0}-pid{1}' -f $script:runStartedAt.ToString('yyyyMMddTHHmmssfffZ'), $PID
$script:deadline = $script:runStartedAt.AddSeconds($TimeoutSeconds)
$script:launches = New-Object System.Collections.ArrayList
$script:screenshots = New-Object System.Collections.ArrayList

if (-not (Test-Path -LiteralPath $script:packageRoot -PathType Container)) { throw "解压包目录不存在：$script:packageRoot" }
if (-not (Test-Path -LiteralPath $script:entryPath -PathType Leaf)) { throw "包内双击入口不存在：$script:entryPath" }
if (-not (Test-Path -LiteralPath $script:launcherScript -PathType Leaf)) { throw "包内 Windows 启动脚本不存在：$script:launcherScript" }
if (-not (Test-Path -LiteralPath $script:nodePath -PathType Leaf)) { throw "包内 Node.js 不存在：$script:nodePath" }
if ((Test-PathWithin -Parent $script:packageRoot -Candidate $script:dataDirectory) -or
    (Test-PathWithin -Parent $script:dataDirectory -Candidate $script:packageRoot)) {
  throw 'PackageRoot 与 DataDirectory 必须互相隔离，不能互相嵌套。'
}
$defaultDataBase = if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
if ([string]::IsNullOrWhiteSpace($defaultDataBase)) { throw '无法定位 Windows 用户数据根目录，拒绝继续。' }
$productionDataRoots = @(
  (Resolve-FullPath -Value (Join-Path $defaultDataBase 'Creative Agent Studio')),
  (Resolve-FullPath -Value (Join-Path $defaultDataBase 'Creative Agent Studio Company'))
)
foreach ($productionDataRoot in $productionDataRoots) {
  if (Test-PathWithin -Parent $productionDataRoot -Candidate $script:dataDirectory) {
    throw '拒绝使用任一 Windows 正式用户数据目录或其子目录作为测试 DataDirectory。'
  }
}
if ((Test-PathWithin -Parent $script:dataDirectory -Candidate $script:evidenceDirectory) -or
    (Test-PathWithin -Parent $script:evidenceDirectory -Candidate $script:dataDirectory) -or
    (Test-PathWithin -Parent $script:packageRoot -Candidate $script:evidenceDirectory) -or
    (Test-PathWithin -Parent $script:evidenceDirectory -Candidate $script:packageRoot)) {
  throw 'PackageRoot、DataDirectory、EvidenceDirectory 必须互相隔离，不能互相嵌套。'
}
if (Test-Path -LiteralPath $script:dataDirectory) {
  $dataItem = Get-Item -LiteralPath $script:dataDirectory -Force
  if (($dataItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw '测试 DataDirectory 不能是符号链接或目录联接。'
  }
}
New-Item -ItemType Directory -Path $script:evidenceDirectory -Force | Out-Null
if ($Action -eq 'configure') {
  if ([string]::IsNullOrWhiteSpace($ConfigurationScript) -or [string]::IsNullOrWhiteSpace($ConfigurationNode)) {
    throw 'configure 必须提供 ConfigurationScript 和 ConfigurationNode。'
  }
  if (-not [System.IO.Path]::IsPathRooted($ConfigurationScript) -or -not (Test-Path -LiteralPath $ConfigurationScript -PathType Leaf)) {
    throw 'ConfigurationScript 必须是存在的绝对文件路径。'
  }
  if (-not [System.IO.Path]::IsPathRooted($ConfigurationNode) -or -not (Test-Path -LiteralPath $ConfigurationNode -PathType Leaf)) {
    throw 'ConfigurationNode 必须是存在的绝对文件路径。'
  }
  $script:configurationScript = Resolve-FullPath -Value $ConfigurationScript
  $script:configurationNode = Resolve-FullPath -Value $ConfigurationNode
  $script:configurationEvidenceDirectory = Join-Path $script:evidenceDirectory "first-config-$Profile"
  New-Item -ItemType Directory -Path $script:configurationEvidenceDirectory -Force | Out-Null
}

if ($Action -eq 'start') {
  if ($WarmStart) {
    $baseWarmReadiness = Get-PythonReadinessSnapshot
    if (Test-Path -LiteralPath (Join-Path $script:dataDirectory 'web\runtime.json') -PathType Leaf) { throw 'WarmStart 前需通过 VBS 停止上一次隔离实例。' }
    $warmLogText = Get-Content -Encoding UTF8 -LiteralPath $script:installLogPath -Raw -ErrorAction Stop
    $baseWarmPrepareCount = [regex]::Matches($warmLogText, '首次启动 Python/OCR 准备开始').Count
    if ($baseWarmPrepareCount -ne 1) { throw "WarmStart 前的隔离日志应只有一次冷启动 prepare，实际为 $baseWarmPrepareCount。" }
  } else {
    if (Test-Path -LiteralPath $script:dataDirectory) {
      $existingItems = @(Get-ChildItem -LiteralPath $script:dataDirectory -Force)
      if ($existingItems.Count -gt 0) { throw '冷启动必须使用独立空 DataDirectory；拒绝复用既有用户数据。' }
    }
  }
} elseif (-not (Test-Path -LiteralPath $script:dataDirectory -PathType Container)) {
  if ($Action -eq 'stop') { throw 'stop 验证需要已有的隔离 DataDirectory。' }
  throw 'configure 验证需要已有的隔离 DataDirectory。'
}

$sessionId = (Get-Process -Id $PID).SessionId
if ($sessionId -eq 0) { throw 'Windows session 0 没有交互式桌面；本次 GUI 验证明确失败。' }
$desktopPath = [WindowsLauncherEvidence.NativeWindow]::GetCurrentDesktopPath()
if (-not $desktopPath.Equals('WinSta0\Default', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "当前桌面不是可见的 WinSta0\Default：$desktopPath；本次 GUI 验证明确失败。"
}
$baseEvidence = if ($Action -eq 'configure') {
  [ordered]@{
    result = 'running'
    startedAtUtc = $script:runStartedAt.ToString('o')
    action = $Action
    profile = $Profile
    resumeConfiguration = [bool]$ResumeConfiguration
    browserEvidenceDirectory = "first-config-$Profile"
    windowsPowerShellVersion = $PSVersionTable.PSVersion.ToString()
    userInteractive = [Environment]::UserInteractive
    sessionId = $sessionId
    sessionName = $env:SESSIONNAME
    desktop = $desktopPath
    driverProcessId = $PID
    screenshots = @()
  }
} else {
  [ordered]@{
  result = 'running'
  startedAtUtc = $script:runStartedAt.ToString('o')
  action = $Action
  profile = $Profile
  product = $script:productName
  packageRoot = $script:packageRoot
  entryPath = $script:entryPath
  dataDirectory = $script:dataDirectory
  evidenceDirectory = $script:evidenceDirectory
  windowsPowerShellVersion = $PSVersionTable.PSVersion.ToString()
  userInteractive = [Environment]::UserInteractive
  sessionId = $sessionId
  sessionName = $env:SESSIONNAME
  desktop = $desktopPath
  driverProcessId = $PID
  warmStart = [bool]$WarmStart
  screenshots = @()
  }
}
$script:baseEvidence = $baseEvidence
if ($WarmStart) { $baseEvidence.prepareStartCountBeforeWarmStart = $baseWarmPrepareCount }
Start-ConsoleWindowMonitor

try {
  if ($Action -eq 'configure') {
    $configurationResult = Invoke-ConfigurationNode -Deadline $script:deadline
    Assert-NoNewConsoleWindows
    $baseEvidence.configurationProcessId = $configurationResult.processId
    $baseEvidence.configurationExitCode = $configurationResult.exitCode
    $baseEvidence.stdoutLines = $configurationResult.stdoutLines
    $baseEvidence.stderrLines = $configurationResult.stderrLines
    $baseEvidence.successSummary = $configurationResult.successSummary
    $baseEvidence.configurationDiagnostic = $configurationResult.diagnostic
    $baseEvidence.consoleWindowMonitor.lastCheckedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
    $baseEvidence.consoleWindowMonitor.outcome = 'no new visible console windows observed while the Node configuration UI test ran'
    $baseEvidence.result = 'passed'
    $baseEvidence.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $baseEvidence.screenshots = @($script:screenshots.ToArray())
    $evidencePath = Save-LaunchEvidence -Name (Get-LaunchEvidenceName) -Value $baseEvidence
    Write-Output "Windows 配置 UI 控制台监测通过；证据：$evidencePath"
  } elseif ($Action -eq 'start') {
    $first = Start-VbsLauncher -EntryPath $script:entryPath -Deadline $script:deadline
    [void]$script:launches.Add($first)
    $firstPrompt = Wait-Window -ProcessId $first.powerShellPid -Kind choice -Deadline $script:deadline
    $firstPromptSnapshot = Get-WindowSnapshot -Window $firstPrompt
    $firstPromptImage = Save-WindowScreenshot -Window $firstPrompt -Name 'launcher-choice.png'
    [void]$script:screenshots.Add($firstPromptImage)
    $baseEvidence.firstVbsPid = $first.host.Id
    $baseEvidence.firstPowerShellPid = $first.powerShellPid
    $baseEvidence.firstChoice = $firstPromptSnapshot

    if (-not $WarmStart) {
      $second = Start-VbsLauncher -EntryPath $script:entryPath -Deadline $script:deadline
      [void]$script:launches.Add($second)
      if ($second.powerShellPid -eq $first.powerShellPid) { throw '重复点击启动得到相同 PowerShell PID，不能证明真实第二次启动。' }
      $duplicateWindow = Wait-Window -ProcessId $second.powerShellPid -Kind duplicate -Deadline $script:deadline
      $duplicateSnapshot = Get-WindowSnapshot -Window $duplicateWindow
      $duplicateImage = Save-WindowScreenshot -Window $duplicateWindow -Name 'launcher-duplicate.png'
      [void]$script:screenshots.Add($duplicateImage)
      $baseEvidence.secondVbsPid = $second.host.Id
      $baseEvidence.secondPowerShellPid = $second.powerShellPid
      $baseEvidence.duplicatePrompt = $duplicateSnapshot
      $baseEvidence.duplicateOkButton = Invoke-Button -Window $duplicateWindow -AutomationId '1' -Names @('OK', '确定') -Description '重复启动提示的 OK'
      $secondExit = Wait-ProcessExit -Process $second.host -Deadline $script:deadline
      if ($secondExit -ne 0) { throw "重复启动 VBS 退出代码为 $secondExit。" }
      $baseEvidence.secondVbsExitCode = $secondExit
    }

    $yesButton = Invoke-Button -Window $firstPrompt -AutomationId '6' -Names @('Yes', '是') -Description '首次启动提示的 Yes'
    $baseEvidence.firstYesButton = $yesButton
    $progressWindow = Wait-Window -ProcessId $first.powerShellPid -Kind progress -Deadline $script:deadline
    $progressSnapshot = Get-WindowSnapshot -Window $progressWindow
    $liveProgress = Wait-ProgressText -Window $progressWindow -ExpectedLogPath $script:installLogPath -Deadline $script:deadline -WarmStart:$WarmStart
    $baseEvidence.progressWindowInitial = Assert-ProgressWindow -Window $progressWindow -ExpectedLogPath $script:installLogPath
    $baseEvidence.liveProgress = $liveProgress
    $progressImage = Save-WindowScreenshot -Window $progressWindow -Name 'launcher-progress-live.png'
    [void]$script:screenshots.Add($progressImage)
    $baseEvidence.progressWindowPid = $first.powerShellPid
    $baseEvidence.progressWindowInitialSnapshot = $progressSnapshot

    if (-not $WarmStart) {
      $prepareText = Get-Content -Encoding UTF8 -LiteralPath $script:installLogPath -Raw -ErrorAction SilentlyContinue
      $prepareCount = [regex]::Matches($prepareText, '首次启动 Python/OCR 准备开始').Count
      if ($prepareCount -ne 1) { throw "冷启动 prepare 记录数应为 1，实际为 $prepareCount。" }
      $baseEvidence.prepareStartCountAfterDuplicate = $prepareCount
    }

    $completion = Wait-Completion -ProcessId $first.powerShellPid -Deadline $script:deadline
    $completionSnapshot = Get-WindowSnapshot -Window $completion
    if ($completionSnapshot.text.Contains('操作未完成')) { throw "真实 Windows 启动操作失败：$($completionSnapshot.text)" }
    $completionImage = Save-WindowScreenshot -Window $completion -Name 'launcher-complete.png'
    [void]$script:screenshots.Add($completionImage)
    $baseEvidence.completionWindow = $completionSnapshot
    $baseEvidence.progressWindowFinal = Assert-ProgressWindow -Window $completion -ExpectedLogPath $script:installLogPath
    $baseEvidence.elapsedSeconds = [Math]::Round(([DateTime]::UtcNow - $script:runStartedAt).TotalSeconds, 3)
    $baseEvidence.prepareLogBytes = (Get-Item -LiteralPath $script:installLogPath).Length
    $baseEvidence.prepareLogSha256 = (Get-FileHash -LiteralPath $script:installLogPath -Algorithm SHA256).Hash
    if (-not $WarmStart) {
      $prepareText = Get-Content -Encoding UTF8 -LiteralPath $script:installLogPath -Raw
      $prepareCount = [regex]::Matches($prepareText, '首次启动 Python/OCR 准备开始').Count
      if ($prepareCount -ne 1) { throw "重复点击导致 prepare 被执行多次；日志记录数为 $prepareCount。" }
      $baseEvidence.prepareStartCountFinal = $prepareCount
    } else {
      $prepareText = Get-Content -Encoding UTF8 -LiteralPath $script:installLogPath -Raw
      $prepareCount = [regex]::Matches($prepareText, '首次启动 Python/OCR 准备开始').Count
      $expectedWarmPrepareCount = $baseWarmPrepareCount + 1
      if ($prepareCount -ne $expectedWarmPrepareCount) { throw "WarmStart 应追加一次 Python/OCR prepare 入口日志；记录数应从 $baseWarmPrepareCount 增加到 $expectedWarmPrepareCount，实际为 $prepareCount。" }
      $baseEvidence.prepareStartCountAfterWarmStart = $prepareCount
      $afterWarmReadiness = Get-PythonReadinessSnapshot
      $beforeWarmJson = ConvertTo-Json -InputObject $baseWarmReadiness -Depth 10 -Compress
      $afterWarmJson = ConvertTo-Json -InputObject $afterWarmReadiness -Depth 10 -Compress
      if ($beforeWarmJson -cne $afterWarmJson) { throw 'WarmStart 改变了 Python venv、锁定依赖指纹或 RapidOCR 模型缓存 SHA。' }
      $baseEvidence.pythonReadinessBeforeWarmStart = $baseWarmReadiness
      $baseEvidence.pythonReadinessAfterWarmStart = $afterWarmReadiness
    }

    [void](Invoke-Button -Window $completion -AutomationId '' -Names @('关闭') -Description '启动完成窗口的关闭')
    $firstExit = Wait-ProcessExit -Process $first.host -Deadline $script:deadline
    if ($firstExit -ne 0) { throw "首次启动 VBS 退出代码为 $firstExit。" }
    $runtime = Wait-RuntimeHealthy -Deadline $script:deadline
    $baseEvidence.runtimeUrl = $runtime.record.url
    $baseEvidence.health = $runtime.health
    $baseEvidence.instanceId = $runtime.record.instanceId
    Assert-NoNewConsoleWindows
    $baseEvidence.consoleWindowMonitor.lastCheckedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
    $baseEvidence.consoleWindowMonitor.outcome = 'no new visible console windows observed by polling during this run'
    $baseEvidence.result = 'passed'
    $baseEvidence.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $baseEvidence.screenshots = @($script:screenshots.ToArray())
    $evidencePath = Save-LaunchEvidence -Name (Get-LaunchEvidenceName) -Value $baseEvidence
    Write-Output "Windows 启动 UI 验证通过；证据：$evidencePath"
    Write-Output "工作台保持运行：$($runtime.record.url)"
  } else {
    $prior = Get-RuntimeRecord
    if (-not $prior) { throw '隔离数据目录没有运行中的 workbench runtime.json，无法验证 GUI stop。' }
    $priorHealth = Test-ControlHealth -Record $prior
    $stop = Start-VbsLauncher -EntryPath $script:entryPath -Deadline $script:deadline
    [void]$script:launches.Add($stop)
    $stopPrompt = Wait-Window -ProcessId $stop.powerShellPid -Kind choice -Deadline $script:deadline
    $stopPromptSnapshot = Get-WindowSnapshot -Window $stopPrompt
    $stopPromptImage = Save-WindowScreenshot -Window $stopPrompt -Name 'launcher-stop-choice.png'
    [void]$script:screenshots.Add($stopPromptImage)
    $baseEvidence.vbsPid = $stop.host.Id
    $baseEvidence.powerShellPid = $stop.powerShellPid
    $baseEvidence.stopChoice = $stopPromptSnapshot
    $baseEvidence.noButton = Invoke-Button -Window $stopPrompt -AutomationId '7' -Names @('No', '否') -Description '停止工作台提示的 No'
    $progressWindow = Wait-Window -ProcessId $stop.powerShellPid -Kind progress -Deadline $script:deadline
    $progressSnapshot = Get-WindowSnapshot -Window $progressWindow
    $baseEvidence.progressWindow = Assert-ProgressWindow -Window $progressWindow
    $progressImage = Save-WindowScreenshot -Window $progressWindow -Name 'launcher-stop-progress.png'
    [void]$script:screenshots.Add($progressImage)
    $completion = Wait-Completion -ProcessId $stop.powerShellPid -Deadline $script:deadline
    $completionSnapshot = Get-WindowSnapshot -Window $completion
    if ($completionSnapshot.text.Contains('操作未完成')) { throw "真实 Windows 停止操作失败：$($completionSnapshot.text)" }
    $completeImage = Save-WindowScreenshot -Window $completion -Name 'launcher-stop-complete.png'
    [void]$script:screenshots.Add($completeImage)
    $baseEvidence.progressWindowSnapshot = $progressSnapshot
    $baseEvidence.completionWindow = $completionSnapshot
    $baseEvidence.priorHealth = $priorHealth
    [void](Invoke-Button -Window $completion -AutomationId '' -Names @('关闭') -Description '停止完成窗口的关闭')
    $stopExit = Wait-ProcessExit -Process $stop.host -Deadline $script:deadline
    if ($stopExit -ne 0) { throw "停止 VBS 退出代码为 $stopExit。" }
    Wait-RuntimeStopped -Record $prior -Deadline $script:deadline
    Assert-NoNewConsoleWindows
    $baseEvidence.consoleWindowMonitor.lastCheckedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
    $baseEvidence.consoleWindowMonitor.outcome = 'no new visible console windows observed by polling during this run'
    $baseEvidence.result = 'passed'
    $baseEvidence.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $baseEvidence.screenshots = @($script:screenshots.ToArray())
    $evidencePath = Save-LaunchEvidence -Name (Get-LaunchEvidenceName) -Value $baseEvidence
    Write-Output "Windows 停止 UI 验证通过；证据：$evidencePath"
  }
} catch {
  $baseEvidence.result = 'failed'
  $baseEvidence.failure = $_.Exception.Message
  if ($baseEvidence.consoleWindowMonitor) {
    $baseEvidence.consoleWindowMonitor.lastCheckedAtUtc = $script:consoleMonitorLastCheckedAt.ToString('o')
    $baseEvidence.consoleWindowMonitor.outcome = if ($script:consoleViolations.Count -gt 0) { 'new visible console window observed' } else { 'run failed; no new visible console window had been observed at failure time' }
    $baseEvidence.consoleWindowMonitor.observedViolations = @($script:consoleViolations.ToArray())
  }
  $baseEvidence.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
  $baseEvidence.screenshots = @($script:screenshots.ToArray())
  try { $failureEvidence = Save-LaunchEvidence -Name (Get-LaunchEvidenceName) -Value $baseEvidence } catch { $failureEvidence = $null }
  if ($failureEvidence) { [Console]::Error.WriteLine("失败证据：$failureEvidence") }
  [Console]::Error.WriteLine("Windows 启动器 GUI 验证明确失败：$($_.Exception.Message)")
  exit 1
} finally {
  foreach ($launch in $script:launches) {
    try { $launch.host.Dispose() } catch { }
  }
}
