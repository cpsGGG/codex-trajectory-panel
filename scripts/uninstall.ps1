$ErrorActionPreference = "Stop"
$launcher = Join-Path $PSScriptRoot "launcher.mjs"
$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if ($nodePath -and (Test-Path -LiteralPath $launcher)) {
    & $nodePath $launcher --shutdown 2>$null
}

$targets = @(
    (Join-Path ([Environment]::GetFolderPath("Startup")) "Codex Trajectory Panel.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Codex - Trajectory.lnk")
)
foreach ($target in $targets) {
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}
$taskName = "Codex Trajectory Panel Watchdog"
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Output "Removed Codex trajectory startup, desktop shortcuts, and self-repair task. The plugin source and local session data were kept."
