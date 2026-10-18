#Requires -Version 5.1
<#
.SYNOPSIS
  Управление billS HUB: start | stop | restart | status | log.

.DESCRIPTION
  hub.ps1 status                — состояние задачи, процессы, /api/health, последний бэкап.
  hub.ps1 start|stop|restart    — через задачу Планировщика (или службу NSSM); stop добивает процессы node.
  hub.ps1 log [-Tail 50]        — хвост hub.log с ожиданием новых строк (Ctrl+C — выход).
  start/stop/restart требуют PowerShell от администратора.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'log')]
    [string]$Action = 'status',
    [string]$Root = 'C:\bills',
    [int]$Tail = 50
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с hub.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
$Port = Get-HubPort -Paths $Paths
$hubLog = Join-Path $Paths.Logs 'hub.log'

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Show-Status {
    Write-Host "billS HUB — $($Paths.Root)"
    if (Test-NssmService) {
        $svc = Get-Service -Name $script:NssmServiceName
        Write-Host "    Служба NSSM:  $($script:NssmServiceName) — $($svc.Status)"
    }
    $task = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
    if ($task) {
        $info = Get-ScheduledTaskInfo -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
        $last = ''
        if ($info) { $last = "последний запуск $($info.LastRunTime), результат $($info.LastTaskResult)" }
        Write-Host "    Задача:       '$($script:HubTaskName)' — $($task.State). $last"
    } else {
        Write-Host "    Задача:       '$($script:HubTaskName)' не зарегистрирована (запустите install.ps1)"
    }
    $bt = Get-ScheduledTask -TaskName $script:BackupTaskName -ErrorAction SilentlyContinue
    if ($bt) {
        $bi = Get-ScheduledTaskInfo -TaskName $script:BackupTaskName -ErrorAction SilentlyContinue
        $next = ''
        if ($bi) { $next = "следующий $($bi.NextRunTime), последний результат $($bi.LastTaskResult)" }
        Write-Host "    Бэкап:        '$($script:BackupTaskName)' — $($bt.State). $next"
    }
    $procs = @(Get-HubProcesses -Paths $Paths)
    if ($procs.Count -eq 0) {
        Write-Host '    Процессы:     нет'
    } else {
        foreach ($p in $procs) { Write-Host "    Процесс:      $($p.Name) PID $($p.ProcessId)" }
    }
    $h = Get-HubHealth -Port $Port
    if ($h) {
        Write-Host "    Health:       OK http://127.0.0.1:$Port/api/health — $(Format-Health -Health $h)" -ForegroundColor Green
    } else {
        Write-Host "    Health:       НЕТ ОТВЕТА от http://127.0.0.1:$Port/api/health" -ForegroundColor Red
    }
    $marker = Get-EnvValue -EnvFile $Paths.EnvFile -Key 'HUB_BACKUP_MARKER' -Default $Paths.Marker
    if (Test-Path -LiteralPath $marker) {
        $raw = (Get-Content -LiteralPath $marker -Raw -ErrorAction SilentlyContinue)
        if ($raw) { Write-Host "    Посл. бэкап:  $($raw.Trim())" }
    } else {
        Write-Host '    Посл. бэкап:  маркер не найден (бэкап ещё не делался?)'
    }
    $lan = @(Get-LanAddresses)
    foreach ($ip in $lan) { Write-Host "    LAN:          http://${ip}:$Port/" }
    Write-Host "    Лог:          $hubLog"
}

switch ($Action) {
    'status' { Show-Status }
    'log' {
        if (-not (Test-Path -LiteralPath $hubLog)) { Fail "Лог $hubLog ещё не создан." }
        Get-Content -LiteralPath $hubLog -Tail $Tail -Wait
    }
    'start' {
        if (-not (Test-Admin)) { Fail 'Нужен PowerShell от администратора.' }
        Start-Hub -Paths $Paths
        $h = Wait-HubHealth -Port $Port -TimeoutSec 60
        if (-not $h) { Fail "HUB не ответил за 60 с. Смотрите $hubLog" }
        Write-Host "HUB работает: $(Format-Health -Health $h)" -ForegroundColor Green
    }
    'stop' {
        if (-not (Test-Admin)) { Fail 'Нужен PowerShell от администратора.' }
        Stop-Hub -Paths $Paths
    }
    'restart' {
        if (-not (Test-Admin)) { Fail 'Нужен PowerShell от администратора.' }
        Stop-Hub -Paths $Paths
        Start-Hub -Paths $Paths
        $h = Wait-HubHealth -Port $Port -TimeoutSec 60
        if (-not $h) { Fail "HUB не ответил за 60 с. Смотрите $hubLog" }
        Write-Host "HUB работает: $(Format-Health -Health $h)" -ForegroundColor Green
    }
}
exit 0
