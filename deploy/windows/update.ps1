#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Обновление billS HUB до указанной версии с автоматическим откатом при неудаче.

.DESCRIPTION
  update.ps1 [-Ref main] [-Root C:\bills] [-SkipBackup]

  Шаги: бэкап → остановка HUB → git fetch/checkout <Ref> → npm ci → сборка web → запуск → /api/health.
  Если HUB не поднялся за 60 с — возврат на прежний commit, npm ci, запуск, повторная проверка.
  Лог: <Root>\logs\update.log.
#>
[CmdletBinding()]
param(
    [string]$Ref = 'main',
    [string]$Root = 'C:\bills',
    [switch]$SkipBackup,
    [int]$HealthTimeoutSec = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с update.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
if (-not (Test-Path -LiteralPath (Join-Path $Paths.App '.git'))) { Fail "В $($Paths.App) нет git-репозитория. Сначала запустите install.ps1." }
New-Item -ItemType Directory -Path $Paths.Logs -Force | Out-Null
Set-BillsLog -Path (Join-Path $Paths.Logs 'update.log')
Write-Log "update.ps1 start: Ref=$Ref Root=$Root SkipBackup=$SkipBackup"

$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCmd) { Fail 'git не найден в PATH.' }
$Port = Get-HubPort -Paths $Paths

$oldSha = Get-GitSha -RepoDir $Paths.App
if (-not $oldSha) { Fail 'Не удалось определить текущий commit (git rev-parse HEAD).' }
Write-Info "Текущая версия: $oldSha"

# ---------------------------------------------------------------------------
# 1. Бэкап
# ---------------------------------------------------------------------------
if ($SkipBackup) {
    Write-Warn 'Бэкап пропущен по флагу -SkipBackup.'
} else {
    Write-Step 'Бэкап перед обновлением'
    $backupScript = Join-Path $PSScriptRoot 'backup.ps1'
    if (-not (Test-Path -LiteralPath $backupScript)) { Fail "Не найден $backupScript." }
    $r = Invoke-Native -FilePath 'powershell.exe' -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $backupScript, '-Root', $Paths.Root)
    if ($r.ExitCode -eq 1) { Fail 'Бэкап не удался — обновление отменено (используйте -SkipBackup только осознанно).' }
    if ($r.ExitCode -ne 0) { Write-Warn "backup.ps1 завершился с кодом $($r.ExitCode) (дополнительная копия не удалась) — продолжаю." }
}

# ---------------------------------------------------------------------------
# 2. Остановка HUB и обновление кода
# ---------------------------------------------------------------------------
Write-Step 'Остановка HUB'
Stop-Hub -Paths $Paths

Write-Step "git fetch + checkout $Ref"
Set-GitRef -RepoDir $Paths.App -Ref $Ref
$newSha = Get-GitSha -RepoDir $Paths.App
Write-Info "Новая версия: $newSha"
if ($newSha -eq $oldSha) { Write-Info 'Код не изменился — всё равно переустановлю зависимости и перезапущу HUB.' }

$scriptsSource = Join-Path $Paths.App 'deploy\windows'
if (Test-Path -LiteralPath (Join-Path $scriptsSource 'run-hub.cmd')) {
    Copy-DeployScripts -Paths $Paths -SourceDir $scriptsSource
    # Подсказка про новые переменные окружения, которых нет в .env.
    $template = Join-Path $scriptsSource 'hub.env.example'
    if ((Test-Path -LiteralPath $template) -and (Test-Path -LiteralPath $Paths.EnvFile)) {
        $missing = @()
        foreach ($line in @(Get-Content -LiteralPath $template -Encoding UTF8)) {
            if ("$line" -match '^\s*([A-Z0-9_]+)\s*=') {
                $key = $Matches[1]
                if ((Get-EnvValue -EnvFile $Paths.EnvFile -Key $key -Default "`0") -eq "`0") { $missing += $key }
            }
        }
        if ($missing.Count -gt 0) {
            Write-Warn "В $($Paths.EnvFile) нет новых переменных: $($missing -join ', ') (см. hub.env.example; используются значения по умолчанию)."
        }
    }
}

function Start-AndCheck {
    param([string]$Label)
    Write-Step "Запуск HUB ($Label)"
    Start-Hub -Paths $Paths
    return (Wait-HubHealth -Port $Port -TimeoutSec $HealthTimeoutSec)
}

$health = $null
if (Install-AppDependencies -Paths $Paths) {
    $health = Start-AndCheck -Label $newSha
} else {
    Write-Warn 'Установка зависимостей или сборка на новой версии не удалась.'
}

if ($health) {
    Write-Host ''
    Write-Host "Обновление успешно: $oldSha → $newSha" -ForegroundColor Green
    Write-Info "HUB: $(Format-Health -Health $health)"
    Write-Log "update OK $oldSha -> $newSha"
    exit 0
}

# ---------------------------------------------------------------------------
# 3. Откат
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host "HUB на версии $newSha не поднялся — откатываюсь на $oldSha." -ForegroundColor Yellow
Write-Log "update FAILED on $newSha, rollback to $oldSha"
Stop-Hub -Paths $Paths
$r = Invoke-Native -FilePath 'git' -Arguments @('checkout', '-q', '-f', '--detach', $oldSha) -WorkingDirectory $Paths.App
if ($r.ExitCode -ne 0) { Fail "Откат не удался: git checkout $oldSha вернул код $($r.ExitCode). Нужно ручное вмешательство." }
$rollbackSource = Join-Path $Paths.App 'deploy\windows'
if (Test-Path -LiteralPath (Join-Path $rollbackSource 'run-hub.cmd')) { Copy-DeployScripts -Paths $Paths -SourceDir $rollbackSource }
if (-not (Install-AppDependencies -Paths $Paths)) {
    Fail "Откат: npm ci/сборка на $oldSha не удались. Нужно ручное вмешательство (HUB остановлен)."
}
$health = Start-AndCheck -Label "откат на $oldSha"
if ($health) {
    Write-Host ''
    Write-Host "ОТКАТ ВЫПОЛНЕН: HUB снова работает на прежней версии $oldSha." -ForegroundColor Yellow
    Write-Host "Обновление до '$Ref' ($newSha) не удалось. Лог HUB: $(Join-Path $Paths.Logs 'hub.log')"
    Write-Log "rollback OK on $oldSha"
    exit 1
}
Fail "Откат на $oldSha тоже не поднял HUB. Смотрите $(Join-Path $Paths.Logs 'hub.log') и запустите hub.ps1 status."
