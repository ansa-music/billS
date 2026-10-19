#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Подключение HUB этого клуба (Windows) к облаку TS сети клубов.

.DESCRIPTION
  connect-cloud.ps1 -Url http://100.x.y.z:4320 -HubId <HUB_ID> -Key <CLOUD_API_KEY> [-Root C:\bills]

  HUB_ID и CLOUD_API_KEY выдаёт владелец на главном мини-ПК (где работает облако):
      sudo bills cloud add-club --name "Название клуба"
  Адрес облака (обычно http://100.x.y.z:4320 — адрес Tailscale главного мини-ПК) там же:
      sudo bills tailscale --status

  Что делает:
   - проверяет, что облако отвечает на <Url>/api/health (если нет — предупреждает, но продолжает);
   - делает копию настроек <Root>\app\.env → .env.bak;
   - записывает в .env строки CLOUD_URL, HUB_ID, CLOUD_API_KEY (заменяет старые или дописывает);
   - перезапускает HUB (задача Планировщика или служба NSSM) и ждёт /api/health.

  Чтобы этот ПК видел облако главного клуба, поставьте Tailscale для Windows
  (https://tailscale.com/download/windows) и войдите ТЕМ ЖЕ аккаунтом, что и на главном мини-ПК.
  Лог: <Root>\logs\connect-cloud.log
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Url,
    [Parameter(Mandatory = $true)][string]$HubId,
    [Parameter(Mandatory = $true)][string]$Key,
    [string]$Root = 'C:\bills',
    [int]$HealthTimeoutSec = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с connect-cloud.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
New-Item -ItemType Directory -Path $Paths.Logs -Force | Out-Null
Set-BillsLog -Path (Join-Path $Paths.Logs 'connect-cloud.log')
Write-Log "connect-cloud.ps1 start: Url=$Url HubId=$HubId Root=$Root"

# ---------------------------------------------------------------------------
# 1. Проверка параметров
# ---------------------------------------------------------------------------
Write-Step 'Проверка параметров'
$Url = $Url.Trim().TrimEnd('/')
$HubId = $HubId.Trim()
$Key = $Key.Trim()
if ($Url -notmatch '^https?://') {
    Fail "Адрес облака должен начинаться с http:// или https:// (например http://100.101.102.103:4320), а сейчас: $Url"
}
if ($HubId -match '\s' -or $Key -match '\s' -or -not $HubId -or -not $Key) {
    Fail 'HUB_ID и ключ не должны быть пустыми и содержать пробелы — скопируйте их точно из вывода «bills cloud add-club».'
}
if (-not (Test-Path -LiteralPath $Paths.EnvFile)) {
    Fail "Не найден файл настроек HUB $($Paths.EnvFile). Сначала установите HUB: install.ps1"
}
Write-Info "Облако: $Url, HUB_ID: $HubId, ключ: <скрыт>"
Write-Info "Настройки HUB: $($Paths.EnvFile)"

# ---------------------------------------------------------------------------
# 2. Облако отвечает?
# ---------------------------------------------------------------------------
Write-Step "Проверка облака: $Url/api/health"
$cloudOk = $false
try {
    $resp = Invoke-WebRequest -Uri "$Url/api/health" -UseBasicParsing -TimeoutSec 8
    if ($resp.StatusCode -eq 200 -and "$($resp.Content)" -match '"ok"\s*:\s*true') { $cloudOk = $true }
} catch {
    Write-Log "health error: $($_.Exception.Message)"
}
if ($cloudOk) {
    Write-Info 'Облако отвечает.'
} else {
    Write-Warn "Облако по адресу $Url не отвечает. Настройки всё равно будут записаны — HUB будет пробовать подключиться сам."
    Write-Warn 'Проверьте: 1) на этом ПК установлен Tailscale (https://tailscale.com/download/windows) и выполнен вход'
    Write-Warn '              тем же аккаунтом, что и на главном мини-ПК (значок Tailscale в трее → Connected);'
    Write-Warn '           2) на главном мини-ПК облако работает: sudo bills status;'
    Write-Warn '           3) адрес и порт верные (обычно http://100.x.y.z:4320).'
}

# ---------------------------------------------------------------------------
# 3. Запись в .env (с резервной копией)
# ---------------------------------------------------------------------------
function Set-EnvLine {
    # Заменяет строку KEY=... (или закомментированную #KEY=...) либо дописывает в конец.
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $active = '^\s*' + [regex]::Escape($Name) + '\s*='
    $commented = '^\s*#\s*' + [regex]::Escape($Name) + '\s*='
    foreach ($pattern in @($active, $commented)) {
        $found = $false
        for ($i = $Lines.Count - 1; $i -ge 0; $i--) {
            if ($Lines[$i] -match $pattern) {
                if ($found) {
                    $Lines.RemoveAt($i)          # дубликаты убираем, остаётся одна строка
                } else {
                    $Lines[$i] = "$Name=$Value"
                    $found = $true
                }
            }
        }
        if ($found) { return }
    }
    $Lines.Add("$Name=$Value")
}

Write-Step "Запись настроек облака в $($Paths.EnvFile)"
$backupFile = "$($Paths.EnvFile).bak"
Copy-Item -LiteralPath $Paths.EnvFile -Destination $backupFile -Force
Write-Info "Копия прежних настроек: $backupFile"

$lines = New-Object System.Collections.Generic.List[string]
foreach ($l in @(Get-Content -LiteralPath $Paths.EnvFile -Encoding UTF8)) { $lines.Add("$l") }
Set-EnvLine -Lines $lines -Name 'CLOUD_URL' -Value $Url
Set-EnvLine -Lines $lines -Name 'HUB_ID' -Value $HubId
Set-EnvLine -Lines $lines -Name 'CLOUD_API_KEY' -Value $Key
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($Paths.EnvFile, $lines.ToArray(), $utf8NoBom)
Write-Info "Записано: CLOUD_URL=$Url, HUB_ID=$HubId, CLOUD_API_KEY=<скрыт>"

# ---------------------------------------------------------------------------
# 4. Перезапуск HUB
# ---------------------------------------------------------------------------
Write-Step 'Перезапуск HUB (игры сохраняются, время считается дальше)'
$Port = Get-HubPort -Paths $Paths
Stop-Hub -Paths $Paths
Start-Hub -Paths $Paths
$health = Wait-HubHealth -Port $Port -TimeoutSec $HealthTimeoutSec
if (-not $health) {
    Write-Warn "HUB не ответил на http://127.0.0.1:$Port/api/health за $HealthTimeoutSec с."
    Write-Warn "Вернуть прежние настройки: Copy-Item '$backupFile' '$($Paths.EnvFile)' -Force; затем $($Paths.Bin)\hub.ps1 restart"
    Write-Warn "Лог HUB: Get-Content '$(Join-Path $Paths.Logs 'hub.log')' -Tail 50"
    Fail 'HUB не поднялся после подключения к облаку.'
}

Write-Host ''
Write-Host '================= HUB подключён к облаку TS =================' -ForegroundColor Green
Write-Host "Облако:        $Url"
Write-Host "HUB_ID:        $HubId"
Write-Host "HUB работает:  $(Format-Health -Health $health)"
Write-Host "Настройки:     $($Paths.EnvFile)  (копия прежних: $backupFile)"
Write-Host "Отправку событий в облако видно в логе HUB: Get-Content '$(Join-Path $Paths.Logs 'hub.log')' -Tail 50 -Wait"
if (-not $cloudOk) {
    Write-Host ''
    Write-Host 'Облако пока не отвечало. Поставьте Tailscale для Windows: https://tailscale.com/download/windows' -ForegroundColor Yellow
    Write-Host 'и войдите тем же аккаунтом, что и на главном мини-ПК — HUB подключится сам, перезапуск не нужен.' -ForegroundColor Yellow
}
Write-Log 'connect-cloud.ps1 finished OK'
exit 0
