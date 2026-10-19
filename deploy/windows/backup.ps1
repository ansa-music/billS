#Requires -Version 5.1
<#
.SYNOPSIS
  Бэкап базы TS HUB: cli.ts backup → zip → удаление старых → (опц.) вторая копия и rclone.

.DESCRIPTION
  backup.ps1 [-Root C:\bills] [-KeepDays 30] [-SecondDir E:\bills-backups] [-RcloneRemote remote:bills-backups]

  Коды выхода: 0 — успех; 1 — бэкап не сделан; 2 — бэкап сделан, но дополнительная копия не удалась.
  Лог: <Root>\logs\backup.log. Запускается задачей Планировщика 'billS Backup' или вручную.
  HUB останавливать не нужно: cli.ts делает консистентную копию (VACUUM INTO).
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\bills',
    [ValidateRange(1, 3650)][int]$KeepDays = 30,
    # Вторая копия на другой диск/флешку. Если диска нет — предупреждение, не ошибка.
    [string]$SecondDir = '',
    # rclone remote (rclone.exe должен быть в PATH), например 'gdrive:bills-backups'.
    [string]$RcloneRemote = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с backup.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
if (-not (Test-Path -LiteralPath $Paths.App)) { Fail "Не найдена папка приложения $($Paths.App). HUB установлен?" }
New-Item -ItemType Directory -Path $Paths.Logs -Force | Out-Null
New-Item -ItemType Directory -Path $Paths.Backups -Force | Out-Null
Set-BillsLog -Path (Join-Path $Paths.Logs 'backup.log')
Write-Log "backup.ps1 start: Root=$Root KeepDays=$KeepDays SecondDir='$SecondDir' RcloneRemote='$RcloneRemote'"

$NodeExe = Resolve-NodeExe
if (-not $NodeExe) { Fail 'node.exe не найден (ни в PATH, ни в Program Files\nodejs).' }
if (-not (Test-Path -LiteralPath $Paths.HubCli)) { Fail "Не найден $($Paths.HubCli)." }

# ---------------------------------------------------------------------------
# 1. cli.ts backup <папка> — создаёт hub-YYYY-MM-DD_HH-mm-ss.db и печатает путь.
# ---------------------------------------------------------------------------
Write-Step "Бэкап базы в $($Paths.Backups)"
$before = @{}
foreach ($f in @(Get-ChildItem -LiteralPath $Paths.Backups -Filter 'hub-*.db' -File -ErrorAction SilentlyContinue)) { $before[$f.FullName] = $true }

$cliArgs = @("--env-file-if-exists=$($Paths.EnvFile)", $Paths.HubCli, 'backup', $Paths.Backups)
$r = Invoke-Native -FilePath $NodeExe -Arguments $cliArgs -WorkingDirectory $Paths.App -Capture
foreach ($line in @($r.Output)) { Write-Log "cli: $line" }
if ($r.ExitCode -ne 0) {
    foreach ($line in @($r.Output)) { Write-Host "    $line" }
    Fail "cli.ts backup завершился с кодом $($r.ExitCode)."
}

# Путь к файлу — строка вывода CLI, оканчивающаяся на .db (ищем с конца); запасной вариант — новый hub-*.db в папке.
$dbFile = $null
$nonEmpty = @($r.Output | Where-Object { "$_".Trim() -ne '' })
for ($i = $nonEmpty.Count - 1; $i -ge 0; $i--) {
    $candidate = "$($nonEmpty[$i])".Trim().Trim('"')
    if ($candidate.ToLower().EndsWith('.db') -and (Test-Path -LiteralPath $candidate)) {
        $dbFile = $candidate
        break
    }
}
if (-not $dbFile) {
    $fresh = @(Get-ChildItem -LiteralPath $Paths.Backups -Filter 'hub-*.db' -File | Where-Object { -not $before.ContainsKey($_.FullName) } | Sort-Object LastWriteTime -Descending)
    if ($fresh.Count -gt 0) { $dbFile = $fresh[0].FullName }
}
if (-not $dbFile) { Fail 'cli.ts backup отработал, но файл бэкапа не найден.' }
$dbInfo = Get-Item -LiteralPath $dbFile
Write-Info ("Создан {0} ({1:N1} МБ)" -f $dbInfo.Name, ($dbInfo.Length / 1MB))

# ---------------------------------------------------------------------------
# 2. Сжатие в .zip и удаление .db
# ---------------------------------------------------------------------------
Write-Step 'Сжатие'
$zipFile = [System.IO.Path]::ChangeExtension($dbFile, '.zip')
try {
    if (Test-Path -LiteralPath $zipFile) { Remove-Item -LiteralPath $zipFile -Force }
    Compress-Archive -LiteralPath $dbFile -DestinationPath $zipFile -CompressionLevel Optimal
} catch {
    Fail "Compress-Archive не удался: $($_.Exception.Message). Несжатый бэкап оставлен: $dbFile"
}
$zipInfo = Get-Item -LiteralPath $zipFile
if ($zipInfo.Length -le 0) { Fail "Архив $zipFile пустой. Несжатый бэкап оставлен: $dbFile" }
Remove-Item -LiteralPath $dbFile -Force
Write-Info ("{0} ({1:N1} МБ)" -f $zipInfo.Name, ($zipInfo.Length / 1MB))
Write-Log "OK $zipFile size=$($zipInfo.Length)"

# ---------------------------------------------------------------------------
# 3. Удаление архивов старше KeepDays
# ---------------------------------------------------------------------------
function Remove-OldBackups {
    param([string]$Dir, [int]$Days)
    $cutoff = (Get-Date).AddDays(-$Days)
    $old = @(Get-ChildItem -LiteralPath $Dir -Filter 'hub-*.zip' -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff })
    foreach ($f in $old) {
        try {
            Remove-Item -LiteralPath $f.FullName -Force
            Write-Log "удалён старый бэкап $($f.FullName)"
        } catch {
            Write-Warn "не удалось удалить $($f.FullName): $($_.Exception.Message)"
        }
    }
    return $old.Count
}
Write-Step "Очистка архивов старше $KeepDays дн."
$removed = Remove-OldBackups -Dir $Paths.Backups -Days $KeepDays
Write-Info "удалено: $removed"

# ---------------------------------------------------------------------------
# 4. Дополнительные копии (не фатально)
# ---------------------------------------------------------------------------
$secondaryFailed = $false

if ($SecondDir) {
    Write-Step "Вторая копия: $SecondDir"
    $drive = $null
    try { $drive = [System.IO.Path]::GetPathRoot($SecondDir) } catch { $drive = $null }
    if ($drive -and -not (Test-Path -LiteralPath $drive)) {
        Write-Warn "Диск $drive недоступен (флешка/второй диск не подключён) — вторая копия пропущена."
    } else {
        try {
            if (-not (Test-Path -LiteralPath $SecondDir)) { New-Item -ItemType Directory -Path $SecondDir -Force | Out-Null }
            Copy-Item -LiteralPath $zipFile -Destination (Join-Path $SecondDir $zipInfo.Name) -Force
            $removed2 = Remove-OldBackups -Dir $SecondDir -Days $KeepDays
            Write-Info "скопировано; удалено старых: $removed2"
        } catch {
            $secondaryFailed = $true
            Write-Warn "вторая копия не удалась: $($_.Exception.Message)"
        }
    }
}

if ($RcloneRemote) {
    Write-Step "rclone → $RcloneRemote"
    $rclone = Get-Command rclone.exe -ErrorAction SilentlyContinue
    if (-not $rclone) {
        $secondaryFailed = $true
        Write-Warn 'rclone.exe не найден в PATH — копия в облако пропущена.'
    } else {
        $rr = Invoke-Native -FilePath $rclone.Source -Arguments @('copy', $zipFile, $RcloneRemote, '--log-level', 'NOTICE') -Capture
        foreach ($line in @($rr.Output)) { Write-Log "rclone: $line" }
        if ($rr.ExitCode -ne 0) {
            $secondaryFailed = $true
            Write-Warn "rclone copy завершился с кодом $($rr.ExitCode)."
        } else {
            Write-Info 'скопировано в облако.'
            # Чистим и облако по тому же сроку (только файлы hub-*.zip).
            $rd = Invoke-Native -FilePath $rclone.Source -Arguments @('delete', $RcloneRemote, '--min-age', "${KeepDays}d", '--include', 'hub-*.zip') -Capture
            if ($rd.ExitCode -ne 0) { Write-Warn "rclone delete (очистка старых) завершился с кодом $($rd.ExitCode)." }
        }
    }
}

Write-Host ''
if ($secondaryFailed) {
    Write-Host "Бэкап сделан: $zipFile, но дополнительная копия не удалась (см. выше)." -ForegroundColor Yellow
    Write-Log 'backup.ps1 finished with warnings (exit 2)'
    exit 2
}
Write-Host "Бэкап готов: $zipFile" -ForegroundColor Green
Write-Log 'backup.ps1 finished OK'
exit 0
