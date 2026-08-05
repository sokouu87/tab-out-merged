[CmdletBinding()]
param(
    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$taskName = 'Tab Out Remote Viewer'

if ($Unregister) {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $existingTask) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "已卸载计划任务：$taskName"
    }
    else {
        Write-Host "计划任务不存在：$taskName"
    }
    return
}

$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $serverDir 'server.mjs'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $serverScript -PathType Leaf)) {
    throw "找不到服务入口：$serverScript"
}

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument ('"{0}"' -f $serverScript) `
    -WorkingDirectory $serverDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal `
    -UserId $currentUser `
    -LogonType S4U `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Starts the local Tab Out remote viewer on 127.0.0.1:8787.' `
    -Force | Out-Null

Write-Host "已注册计划任务：$taskName"
Write-Host "运行用户：$currentUser"
Write-Host "服务入口：$serverScript"
