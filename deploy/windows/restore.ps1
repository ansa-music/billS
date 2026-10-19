#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Восстановление базы TS HUB из бэкапа (.zip или .db).

.DESCRIPTION
  restore.ps1                      — показать последние бэкапы.
  restore.ps1 -File <путь .db|.zip> [-Root C:\bills] [-Yes]

  Шаги: проверка файла (cli.ts check) → подтверждение → остановка HUB → cli.ts restore --yes → запуск → /api/health.
  Старая база сохраняется самим CLI как hub.db.before-restore-<штамп>.
#>
[CmdletBinding()]
param(
    [string]$File = '',
    [string]$Root = 'C:\bills',
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с restore.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
New-Item -ItemType Directory -Path $Paths.Logs -Force | Out-Null
Set-BillsLog -Path (Join-Path $Paths.Logs 'restore.log')

# ---------------------------------------------------------------------------
# Без -File: список последних бэкапов
# ---------------------------------------------------------------------------
if (-not $File) {
    Write-Host "Последние бэкапы в $($Paths.Backups):"
    $list = @()
    if (Test-Path -LiteralPath $Paths.Backups) {
        $list = @(Get-ChildItem -LiteralPath $Paths.Backups -File | Where-Object { $_.Name -like 'hub-*.zip' -or $_.Name -like 'hub-*.db' } | Sort-Object LastWriteTime -Descending | Select-Object -First 15)
    }
    if ($list.Count -eq 0) {
        Write-Host '    (пусто)'
    } else {
        foreach ($f in $list) {
            Write-Host ("    {0,-32} {1,10:N1} МБ   {2:yyyy-MM-dd HH:mm}" -f $f.Name, ($f.Length / 1MB), $f.LastWriteTime)
        }
    }
    Write-Host ''
    Write-Host "Восстановить: restore.ps1 -File `"$($Paths.Backups)\hub-....zip`""
    exit 0
}

Write-Log "restore.ps1 start: File=$File Root=$Root Yes=$Yes"

$NodeExe = Resolve-NodeExe
if (-not $NodeExe) { Fail 'node.exe не найден.' }
if (-not (Test-Path -LiteralPath $Paths.HubCli)) { Fail "Не найден $($Paths.HubCli)." }
if (-not (Test-Path -LiteralPath $File)) {
    # Разрешаем указывать просто имя файла из папки бэкапов.
    $alt = Join-Path $Paths.Backups $File
    if (Test-Path -LiteralPath $alt) { $File = $alt } else { Fail "Файл не найден: $File" }
}
$File = (Resolve-Path -LiteralPath $File).Path

# ---------------------------------------------------------------------------
# 1. Распаковка (если zip)
# ---------------------------------------------------------------------------
$tempDir = $null
$dbFile = $File
$ext = [System.IO.Path]::GetExtension($File).ToLower()
if ($ext -eq '.zip') {
    Write-Step "Распаковка $File"
    $tempDir = Join-Path $env:TEMP ('bills-restore-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    Expand-Archive -LiteralPath $File -DestinationPath $tempDir -Force
    $dbs = @(Get-ChildItem -LiteralPath $tempDir -Filter '*.db' -File -Recurse)
    if ($dbs.Count -ne 1) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        Fail "В архиве ожидался ровно один файл .db, найдено: $($dbs.Count)."
    }
    $dbFile = $dbs[0].FullName
    Write-Info "распакован $($dbs[0].Name)"
} elseif ($ext -ne '.db') {
    Fail "Ожидается файл .zip или .db, получен: $File"
}

function Remove-TempDir {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 2. Проверка целостности файла бэкапа (HUB ещё работает — безопасно)
# ---------------------------------------------------------------------------
Write-Step 'Проверка целостности бэкапа (cli.ts check)'
$chk = Invoke-Native -FilePath $NodeExe -Arguments @("--env-file-if-exists=$($Paths.EnvFile)", $Paths.HubCli, 'check', $dbFile) -WorkingDirectory $Paths.App -Capture
foreach ($line in @($chk.Output)) { Write-Host "    $line"; Write-Log "check: $line" }
if ($chk.ExitCode -ne 0) {
    Remove-TempDir
    Fail "Файл бэкапа не прошёл проверку (код $($chk.ExitCode)). Восстановление отменено, HUB не трогали."
}

# ---------------------------------------------------------------------------
# 3. Подтверждение
# ---------------------------------------------------------------------------
$currentDb = Get-EnvValue -EnvFile $Paths.EnvFile -Key 'HUB_DB_PATH' -Default $Paths.DbPath
$src = Get-Item -LiteralPath $dbFile
Write-Host ''
Write-Host 'ВНИМАНИЕ: текущая база будет заменена содержимым бэкапа.' -ForegroundColor Yellow
Write-Host "    Бэкап:        $File"
Write-Host ("    Размер/дата:  {0:N1} МБ, {1:yyyy-MM-dd HH:mm}" -f ($src.Length / 1MB), (Get-Item -LiteralPath $File).LastWriteTime)
Write-Host "    Текущая база: $currentDb (будет сохранена как hub.db.before-restore-<штамп>)"
Write-Host '    Все игры и счета, созданные после момента бэкапа, в базе исчезнут.'
if (-not $Yes) {
    $answer = Read-Host 'Введите YES, чтобы продолжить'
    if ($answer -cne 'YES') {
        Remove-TempDir
        Write-Host 'Отменено.'
        exit 0
    }
}

# ---------------------------------------------------------------------------
# 4. Стоп → restore → старт
# ---------------------------------------------------------------------------
Write-Step 'Остановка HUB'
Stop-Hub -Paths $Paths

Write-Step 'cli.ts restore'
$res = Invoke-Native -FilePath $NodeExe -Arguments @("--env-file-if-exists=$($Paths.EnvFile)", $Paths.HubCli, 'restore', $dbFile, '--yes') -WorkingDirectory $Paths.App -Capture
foreach ($line in @($res.Output)) { Write-Host "    $line"; Write-Log "restore: $line" }
$restoreOk = ($res.ExitCode -eq 0)
if (-not $restoreOk) { Write-Warn "cli.ts restore завершился с кодом $($res.ExitCode). Запускаю HUB с прежней базой." }

Write-Step 'Запуск HUB'
$Port = Get-HubPort -Paths $Paths
Start-Hub -Paths $Paths
$health = Wait-HubHealth -Port $Port -TimeoutSec 60
Remove-TempDir

if (-not $restoreOk) { Fail 'Восстановление не выполнено (см. сообщения CLI выше).' }
if (-not $health) { Fail "База восстановлена, но HUB не ответил за 60 с. Смотрите $(Join-Path $Paths.Logs 'hub.log')." }
Write-Host ''
Write-Host "Восстановление выполнено. HUB: $(Format-Health -Health $health)" -ForegroundColor Green
Write-Log "restore OK from $File"
exit 0
