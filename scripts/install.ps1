$ErrorActionPreference = "Stop"

$pluginRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodePath --version).Trim()
$nodeMajor = [int]($nodeVersion -replace '^v(\d+).*$', '$1')
if ($nodeMajor -lt 22) { throw "Node.js 22 or newer is required. Found $nodeVersion at $nodePath." }

$package = Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1
if (-not $package) { throw "Microsoft Store OpenAI Codex is not installed." }
$manifestPath = Join-Path $package.InstallLocation "AppxManifest.xml"
[xml]$manifest = Get-Content -LiteralPath $manifestPath
$relativeExe = ($manifest.Package.Applications.Application | Select-Object -First 1).Executable
$codexExe = Join-Path $package.InstallLocation $relativeExe
if (-not (Test-Path -LiteralPath $codexExe)) { throw "Codex executable not found: $codexExe" }

$startupFolder = [Environment]::GetFolderPath("Startup")
$desktopFolder = [Environment]::GetFolderPath("Desktop")
$wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
$shell = New-Object -ComObject WScript.Shell

$startupLink = Join-Path $startupFolder "Codex Trajectory Panel.lnk"
$shortcut = $shell.CreateShortcut($startupLink)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot "start-hidden.vbs") + '"'
$shortcut.WorkingDirectory = $pluginRoot
$shortcut.Description = "Codex embedded trajectory companion (starts at sign-in)"
$shortcut.IconLocation = "$codexExe,0"
$shortcut.Save()

$desktopLink = Join-Path $desktopFolder "Codex - Trajectory.lnk"
$shortcut = $shell.CreateShortcut($desktopLink)
$shortcut.TargetPath = $wscriptPath
$shortcut.Arguments = '"' + (Join-Path $PSScriptRoot "launch-codex.vbs") + '"'
$shortcut.WorkingDirectory = $pluginRoot
$shortcut.Description = "Open Codex with the embedded trajectory view"
$shortcut.IconLocation = "$codexExe,0"
$shortcut.Save()

$supportFolder = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".codex\trajectory-panel"
New-Item -ItemType Directory -Force -Path $supportFolder | Out-Null
Set-Content -LiteralPath (Join-Path $supportFolder "codex-path.txt") -Value $codexExe -Encoding UTF8

$taskName = "Codex Trajectory Panel Watchdog"
$watchdogScript = Join-Path $PSScriptRoot "watchdog.vbs"
$taskAction = New-ScheduledTaskAction -Execute $wscriptPath -Argument ('"' + $watchdogScript + '"')
$taskTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$taskSettings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Settings $taskSettings -Description "Restores the Codex trajectory companion after Codex or app updates stop it." -Force | Out-Null

Write-Output "Installed startup shortcut: $startupLink"
Write-Output "Installed desktop shortcut: $desktopLink"
Write-Output "Installed self-repair task: $taskName"
Write-Output "Codex executable: $codexExe"
Write-Output "Node.js: $nodeVersion ($nodePath)"
