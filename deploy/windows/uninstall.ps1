#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Удаляет задачи Планировщика TS и правило брандмауэра. Данные, код и бэкапы НЕ удаляет.

.DESCRIPTION
  uninstall.ps1 [-Root C:\bills]
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\bills'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с uninstall.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
if (Test-Path -LiteralPath $Paths.Logs) { Set-BillsLog -Path (Join-Path $Paths.Logs 'install.log') }
Write-Log "uninstall.ps1 start: Root=$Root"

Write-Step 'Остановка HUB'
if (Test-NssmService) {
    Write-Warn "Найдена служба NSSM '$($script:NssmServiceName)'. Её этот скрипт не трогает: nssm stop $($script:NssmServiceName); nssm remove $($script:NssmServiceName) confirm"
}
$task = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue }
}
$procs = @(Get-HubProcesses -Paths $Paths)
$ordered = @($procs | Where-Object { $_.Name -ieq 'cmd.exe' }) + @($procs | Where-Object { $_.Name -ieq 'node.exe' })
foreach ($p in $ordered) {
    Write-Info "Завершаю процесс $($p.Name) PID $($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Step 'Задачи Планировщика'
foreach ($name in @($script:HubTaskName, $script:BackupTaskName)) {
    $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Info "удалена задача '$name'"
    } else {
        Write-Info "задачи '$name' нет"
    }
}

Write-Step 'Правило брандмауэра'
$rule = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue
if ($rule) {
    Remove-NetFirewallRule -DisplayName $script:FirewallRuleName | Out-Null
    Write-Info "удалено правило '$($script:FirewallRuleName)'"
} else {
    Write-Info "правила '$($script:FirewallRuleName)' нет"
}

Write-Host ''
Write-Host 'Задачи и правило брандмауэра удалены. Данные оставлены на месте:' -ForegroundColor Green
Write-Host "    База данных:   $($Paths.Data)"
Write-Host "    Бэкапы:        $($Paths.Backups)"
Write-Host "    Код и .env:    $($Paths.App)"
Write-Host "    Логи, скрипты: $($Paths.Logs), $($Paths.Bin)"
Write-Host ''
Write-Host 'Если всё это больше не нужно (СНАЧАЛА скопируйте бэкапы в надёжное место):'
Write-Host "    Remove-Item -Recurse -Force '$($Paths.Root)'"
Write-Host 'Node.js и git остаются установленными (удаляются через «Приложения и возможности»).'
Write-Log 'uninstall.ps1 finished'
exit 0
