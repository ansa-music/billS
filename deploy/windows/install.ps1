#Requires -Version 5.1
#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Установка TS HUB на Windows (запасной вариант ОС). Идемпотентна: можно запускать повторно.

.DESCRIPTION
  powershell -ExecutionPolicy Bypass -File install.ps1 [-Ref main] [-Root C:\bills] [-HubHost 0.0.0.0] [-Port 4310]
                                                        [-RunAs DOMAIN\user] [-SecondDir E:\bills-backups] [-RcloneRemote remote:bills]

  Что делает:
   - проверяет Node >= 24 и git (ставит через winget, если их нет);
   - клонирует репозиторий в <Root>\app (или обновляет до <Ref>), создаёт data/backups/logs/bin;
   - создаёт <Root>\app\.env из hub.env.example (существующий .env не трогает);
   - npm ci и сборка экрана зала;
   - задача Планировщика 'billS HUB' (при запуске системы, от SYSTEM, перезапуск при падении) через bin\run-hub.cmd;
   - правило брандмауэра только для частной/доменной сети;
   - задача Планировщика 'billS Backup' ежедневно в 03:30 (bin\backup.ps1);
   - запускает HUB и ждёт /api/health.
#>
[CmdletBinding()]
param(
    [string]$Ref = 'main',
    [string]$Root = 'C:\bills',
    [string]$HubHost = '0.0.0.0',
    [ValidateRange(1, 65535)][int]$Port = 4310,
    # Учётная запись для задачи HUB вместо NT AUTHORITY\SYSTEM (пароль будет запрошен).
    [string]$RunAs = '',
    # Вторая копия бэкапов (флешка/второй диск), передаётся в backup.ps1.
    [string]$SecondDir = '',
    # rclone remote для копии бэкапа в облако, например 'gdrive:bills-backups'.
    [string]$RcloneRemote = '',
    [int]$BackupKeepDays = 30,
    [string]$BackupTime = '03:30'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'common.ps1'
if (-not (Test-Path -LiteralPath $commonPath)) {
    Write-Host "ОШИБКА: рядом с install.ps1 нет common.ps1 ($commonPath)." -ForegroundColor Red
    exit 1
}
. $commonPath

$Paths = Get-BillsPaths -Root $Root
New-Item -ItemType Directory -Path $Paths.Logs -Force | Out-Null
Set-BillsLog -Path (Join-Path $Paths.Logs 'install.log')
Write-Log "install.ps1 start: Ref=$Ref Root=$Root HubHost=$HubHost Port=$Port RunAs='$RunAs'"

# ---------------------------------------------------------------------------
# 1. Node >= 24 и git
# ---------------------------------------------------------------------------
function Get-NodeMajor {
    $exe = Resolve-NodeExe
    if (-not $exe) { return 0 }
    $r = Invoke-Native -FilePath $exe -Arguments @('--version') -Capture
    if ($r.ExitCode -ne 0 -or $r.Output.Count -eq 0) { return 0 }
    $v = "$($r.Output[0])".Trim()
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

function Test-Winget {
    $w = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($w) { return $true }
    return $false
}

# Запасной путь без winget (нет App Installer, Windows LTSC, другой администратор): официальный MSI
# Node.js с nodejs.org, версия закреплена, SHA-256 проверяется.
$script:NodeMsiVersion = '24.22.1'
$script:NodeMsiSha256 = '3bda4baf1ee709b33cf920dd633106ddb23951e322bff9c03ec9f64ab8981b01'

function Install-NodeMsi {
    $url = "https://nodejs.org/dist/v$($script:NodeMsiVersion)/node-v$($script:NodeMsiVersion)-x64.msi"
    $msi = Join-Path ([IO.Path]::GetTempPath()) "node-v$($script:NodeMsiVersion)-x64.msi"
    Write-Info "Скачиваю Node.js $($script:NodeMsiVersion): $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing
    } catch {
        Write-Warn "Не удалось скачать Node.js: $($_.Exception.Message)"
        return 1
    }
    $actual = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $script:NodeMsiSha256) {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
        Write-Warn "Скачанный файл Node.js не прошёл проверку SHA-256 ($actual) — не устанавливаю."
        return 1
    }
    Write-Info 'Устанавливаю Node.js (msiexec, без окон)'
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', "`"$msi`"", '/qn', '/norestart') -Wait -PassThru
    Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    Update-PathFromRegistry
    return $p.ExitCode
}

function Install-WithWinget {
    param([string]$Id, [switch]$Upgrade)
    $verb = 'install'
    if ($Upgrade) { $verb = 'upgrade' }
    Write-Info "winget $verb --id $Id"
    $r = Invoke-Native -FilePath 'winget' -Arguments @($verb, '--id', $Id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements')
    Update-PathFromRegistry
    return $r.ExitCode
}

Write-Step 'Проверка Node.js (нужна версия 24 или новее)'
$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 24) {
    Write-Info "Node.js найден: $(Resolve-NodeExe) (v$nodeMajor)"
} else {
    if ($nodeMajor -gt 0) { Write-Warn "Установлен Node.js v$nodeMajor — слишком старый." } else { Write-Info 'Node.js не найден.' }
    if (Test-Winget) {
        if ($nodeMajor -gt 0) { [void](Install-WithWinget -Id 'OpenJS.NodeJS.LTS' -Upgrade) }
        if ((Get-NodeMajor) -lt 24) { [void](Install-WithWinget -Id 'OpenJS.NodeJS.LTS') }
        $nodeMajor = Get-NodeMajor
    }
    if ($nodeMajor -lt 24) {
        [void](Install-NodeMsi)
        $nodeMajor = Get-NodeMajor
    }
    if ($nodeMajor -lt 24) {
        Fail ("Node.js 24+ не установлен. Скачайте MSI (Windows Installer, 64-bit) с https://nodejs.org/en/download , " +
              "установите его и запустите install.ps1 ещё раз.")
    }
    Write-Info "Node.js установлен: $(Resolve-NodeExe) (v$nodeMajor)"
}
$NodeExe = Resolve-NodeExe

Write-Step 'Проверка git'
$gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $gitCmd) {
    Write-Info 'git не найден.'
    if (Test-Winget) {
        [void](Install-WithWinget -Id 'Git.Git')
        $gitCmd = Get-Command git.exe -ErrorAction SilentlyContinue
    }
    if (-not $gitCmd) {
        Fail 'git не установлен. Скачайте установщик с https://git-scm.com/download/win и запустите install.ps1 ещё раз.'
    }
}
Write-Info "git: $($gitCmd.Source)"

# ---------------------------------------------------------------------------
# 2. Структура папок и код приложения
# ---------------------------------------------------------------------------
Write-Step "Папки в $Root"
foreach ($dir in @($Paths.Root, $Paths.Data, $Paths.Backups, $Paths.Logs, $Paths.Bin)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
        Write-Info "создана $dir"
    }
}

Write-Step "Код приложения: $($Paths.App) (ref: $Ref)"
# Повторная установка поверх работающего HUB: остановим его до git checkout и npm ci.
$runningTask = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
if (($runningTask -and $runningTask.State -eq 'Running') -or (Test-NssmService) -or (@(Get-HubProcesses -Paths $Paths).Count -gt 0)) {
    Write-Info 'HUB сейчас работает — останавливаю на время установки.'
    Stop-Hub -Paths $Paths
}
$gitDir = Join-Path $Paths.App '.git'
if (Test-Path -LiteralPath $gitDir) {
    Write-Info 'Репозиторий уже есть — git fetch + checkout.'
    Set-GitRef -RepoDir $Paths.App -Ref $Ref
} elseif (Test-Path -LiteralPath $Paths.App) {
    $existing = @(Get-ChildItem -LiteralPath $Paths.App -Force)
    if ($existing.Count -gt 0) {
        Fail "Папка $($Paths.App) существует, но это не git-репозиторий. Переместите её и запустите снова."
    }
    Remove-Item -LiteralPath $Paths.App -Force
}
if (-not (Test-Path -LiteralPath $gitDir)) {
    Write-Info "git clone $script:RepoUrl"
    $r = Invoke-Native -FilePath 'git' -Arguments @('clone', '--quiet', $script:RepoUrl, $Paths.App)
    if ($r.ExitCode -ne 0) { Fail "git clone завершился с кодом $($r.ExitCode). Проверьте доступ в интернет." }
    Set-GitRef -RepoDir $Paths.App -Ref $Ref
}
$sha = Get-GitSha -RepoDir $Paths.App
Write-Info "Текущая версия: $sha"

# Скрипты развёртывания: предпочитаем свежие из репозитория, иначе — из папки, откуда запущен install.ps1.
$scriptsSource = Join-Path $Paths.App 'deploy\windows'
if (-not (Test-Path -LiteralPath (Join-Path $scriptsSource 'run-hub.cmd'))) { $scriptsSource = $PSScriptRoot }
Copy-DeployScripts -Paths $Paths -SourceDir $scriptsSource

# ---------------------------------------------------------------------------
# 3. .env
# ---------------------------------------------------------------------------
Write-Step "Конфигурация $($Paths.EnvFile)"
$templatePath = Join-Path $scriptsSource 'hub.env.example'
if (-not (Test-Path -LiteralPath $templatePath)) { $templatePath = Join-Path $PSScriptRoot 'hub.env.example' }
if (Test-Path -LiteralPath $Paths.EnvFile) {
    Write-Info '.env уже существует — не перезаписываю.'
    $curHost = Get-EnvValue -EnvFile $Paths.EnvFile -Key 'HUB_HOST' -Default '127.0.0.1'
    $curPort = Get-EnvValue -EnvFile $Paths.EnvFile -Key 'HUB_PORT' -Default '4310'
    Write-Info "Текущие значения: HUB_HOST=$curHost HUB_PORT=$curPort"
    if ($curHost -ne $HubHost -or "$curPort" -ne "$Port") {
        Write-Warn "Параметры -HubHost/-Port отличаются от .env. Если нужно изменить — отредактируйте .env вручную."
    }
    $Port = [int]$curPort
    $HubHost = $curHost
} else {
    if (-not (Test-Path -LiteralPath $templatePath)) { Fail "Не найден шаблон hub.env.example ($templatePath)." }
    $lines = @(Get-Content -LiteralPath $templatePath -Encoding UTF8)
    $out = New-Object System.Collections.Generic.List[string]
    foreach ($line in $lines) {
        $l = "$line"
        if ($l -match '^\s*HUB_HOST\s*=') { $l = "HUB_HOST=$HubHost" }
        elseif ($l -match '^\s*HUB_PORT\s*=') { $l = "HUB_PORT=$Port" }
        elseif ($l -match '^\s*HUB_DB_PATH\s*=') { $l = "HUB_DB_PATH=$($Paths.DbPath)" }
        elseif ($l -match '^\s*HUB_BACKUP_MARKER\s*=') { $l = "HUB_BACKUP_MARKER=$($Paths.Marker)" }
        $out.Add($l)
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($Paths.EnvFile, $out.ToArray(), $utf8NoBom)
    Write-Info ".env создан: HUB_HOST=$HubHost HUB_PORT=$Port HUB_DB_PATH=$($Paths.DbPath)"
}

# ---------------------------------------------------------------------------
# 4. Зависимости и сборка
# ---------------------------------------------------------------------------
if (-not (Install-AppDependencies -Paths $Paths)) {
    Fail 'Установка зависимостей или сборка не удалась (см. вывод npm выше).'
}

# ---------------------------------------------------------------------------
# 5. Задача Планировщика 'billS HUB'
# ---------------------------------------------------------------------------
Write-Step "Задача Планировщика '$($script:HubTaskName)'"
if (Test-NssmService) {
    Write-Warn "Обнаружена служба NSSM '$($script:NssmServiceName)'. Задача Планировщика будет создана, но ОТКЛЮЧЕНА — HUB запускает служба."
}

$taskArgs = "`"$($Paths.Root)`" `"$NodeExe`""
$hubAction = New-ScheduledTaskAction -Execute $Paths.RunCmd -Argument $taskArgs -WorkingDirectory $Paths.App
$hubTrigger = New-ScheduledTaskTrigger -AtStartup
$hubSettings = New-ScheduledTaskSettingsSet `
    -Compatibility Win8 `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
# PT0S = без ограничения времени выполнения (ITaskSettings.ExecutionTimeLimit).
$hubSettings.ExecutionTimeLimit = 'PT0S'
$hubSettings.Priority = 4   # обычный приоритет (по умолчанию у задач 7 — ниже обычного)

$registerParams = @{
    TaskName    = $script:HubTaskName
    Action      = $hubAction
    Trigger     = $hubTrigger
    Settings    = $hubSettings
    Description = "TS HUB — сервер клуба. Обёртка: $($Paths.RunCmd). Лог: $(Join-Path $Paths.Logs 'hub.log')"
    Force       = $true
}
if ($RunAs) {
    $cred = Get-Credential -UserName $RunAs -Message "Пароль учётной записи $RunAs для задачи '$($script:HubTaskName)'"
    if (-not $cred) { Fail 'Учётные данные не введены.' }
    $registerParams.User = $cred.UserName
    $registerParams.Password = $cred.GetNetworkCredential().Password
    $registerParams.RunLevel = 'Highest'
} else {
    $registerParams.Principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
}
# Если задача уже запущена — остановим перед перерегистрацией, чтобы не осталось «осиротевших» node.
$existingTask = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
    Write-Info 'Задача уже выполняется — останавливаю перед обновлением.'
    Stop-Hub -Paths $Paths
}
Register-ScheduledTask @registerParams | Out-Null
if (Test-NssmService) { Disable-ScheduledTask -TaskName $script:HubTaskName | Out-Null }
Write-Info "Задача зарегистрирована: $($Paths.RunCmd) $taskArgs"

# ---------------------------------------------------------------------------
# 6. Брандмауэр (только частная/доменная сеть)
# ---------------------------------------------------------------------------
Write-Step 'Правило брандмауэра Windows'
$oldRule = Get-NetFirewallRule -DisplayName $script:FirewallRuleName -ErrorAction SilentlyContinue
if ($oldRule) {
    Remove-NetFirewallRule -DisplayName $script:FirewallRuleName | Out-Null
}
if ($HubHost -eq '127.0.0.1' -or $HubHost -eq 'localhost') {
    Write-Info 'HUB_HOST=127.0.0.1 — HUB доступен только с этого ПК, правило брандмауэра не требуется.'
} else {
    New-NetFirewallRule -DisplayName $script:FirewallRuleName -Direction Inbound -Action Allow -Protocol TCP `
        -LocalPort $Port -Profile @('Private', 'Domain') -Description 'TS HUB: доступ планшетов и экрана зала из локальной сети' | Out-Null
    Write-Info "Открыт TCP $Port для профилей «Частная» и «Доменная» сеть."
    Write-Warn 'HUB НЕ должен быть доступен из интернета: не пробрасывайте порт на роутере, не включайте профиль «Общедоступная».'
    Write-Warn 'Если сеть клуба определена Windows как «Общедоступная» — переключите её на «Частная» (Параметры → Сеть и Интернет → свойства сети).'
}

# ---------------------------------------------------------------------------
# 7. Задача 'billS Backup'
# ---------------------------------------------------------------------------
Write-Step "Задача Планировщика '$($script:BackupTaskName)' (ежедневно в $BackupTime)"
$backupScript = Join-Path $Paths.Bin 'backup.ps1'
$backupArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -Root `"$($Paths.Root)`" -KeepDays $BackupKeepDays"
if ($SecondDir) { $backupArgs += " -SecondDir `"$SecondDir`"" }
if ($RcloneRemote) { $backupArgs += " -RcloneRemote `"$RcloneRemote`"" }
$backupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $backupArgs -WorkingDirectory $Paths.App
$backupTrigger = New-ScheduledTaskTrigger -Daily -At $BackupTime
$backupSettings = New-ScheduledTaskSettingsSet -Compatibility Win8 -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$backupPrincipal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $script:BackupTaskName -Action $backupAction -Trigger $backupTrigger `
    -Settings $backupSettings -Principal $backupPrincipal -Force `
    -Description "TS: ежедневный бэкап базы в $($Paths.Backups). Лог: $(Join-Path $Paths.Logs 'backup.log')" | Out-Null
Write-Info "powershell.exe $backupArgs"

# ---------------------------------------------------------------------------
# 8. Запуск и проверка
# ---------------------------------------------------------------------------
Write-Step 'Запуск HUB'
# Порт уже занят (встроенный HUB приложения TS, другая программа): иначе проверка ниже «увидит»
# чужой HUB и скажет, что всё хорошо, а служба будет падать с EADDRINUSE.
$owner = Get-PortOwner -Port $Port
if ($owner) {
    Fail ("Порт $Port уже занят: $($owner.Name) (PID $($owner.ProcessId)). Если это встроенный HUB приложения TS — " +
          "остановите его (TS → Настройки → «Остановить HUB на этом компьютере») и запустите установку ещё раз.")
}
Start-Hub -Paths $Paths
$health = Wait-HubHealth -Port $Port -TimeoutSec 60
if (-not $health) {
    Write-Warn "HUB не ответил на http://127.0.0.1:$Port/api/health за 60 с."
    Write-Warn "Смотрите лог: Get-Content '$(Join-Path $Paths.Logs 'hub.log')' -Tail 50"
    Fail 'Установка завершена, но HUB не поднялся.'
}
Write-Info "HUB работает: $(Format-Health -Health $health)"

# ---------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------
$lan = @(Get-LanAddresses)
Write-Host ''
Write-Host '================= TS HUB установлен =================' -ForegroundColor Green
Write-Host "Версия кода:        $sha ($Ref)"
if ($HubHost -eq '127.0.0.1' -or $HubHost -eq 'localhost') {
    Write-Host "Адрес (только ПК):  http://127.0.0.1:$Port/"
} else {
    Write-Host 'Адрес для планшетов и экрана зала:'
    if ($lan.Count -eq 0) { Write-Host "    http://<IP этого ПК>:$Port/" }
    foreach ($ip in $lan) { Write-Host "    http://${ip}:$Port/" }
    Write-Host '    (IP лучше закрепить за этим ПК в настройках роутера — DHCP reservation)'
}
Write-Host "Проверка здоровья:  http://127.0.0.1:$Port/api/health"
Write-Host "База данных:        $($Paths.DbPath)"
Write-Host "Бэкапы:             $($Paths.Backups) (ежедневно в $BackupTime, хранить $BackupKeepDays дн.)"
Write-Host "Конфигурация:       $($Paths.EnvFile)"
Write-Host "Лог HUB:            Get-Content '$(Join-Path $Paths.Logs 'hub.log')' -Tail 50 -Wait"
Write-Host "Логи скриптов:      $($Paths.Logs)\install.log, backup.log, update.log"
Write-Host ''
Write-Host 'Управление (PowerShell от администратора):'
Write-Host "    Start-ScheduledTask -TaskName '$($script:HubTaskName)'"
Write-Host "    Stop-ScheduledTask  -TaskName '$($script:HubTaskName)'   # или: $($Paths.Bin)\hub.ps1 stop (добивает процессы node)"
Write-Host "    $($Paths.Bin)\hub.ps1 status | restart | log"
Write-Host "    Обновление:     $($Paths.Bin)\update.ps1 -Ref $Ref"
Write-Host "    Бэкап вручную:  $($Paths.Bin)\backup.ps1"
Write-Host "    Восстановление: $($Paths.Bin)\restore.ps1 -File <файл .zip|.db>"
Write-Host ''
Write-Host 'ВАЖНО — автоперезагрузка Windows после обновлений:' -ForegroundColor Yellow
Write-Host '    Скрипт системные настройки не меняет. Чтобы Windows не перезагружала HUB посреди смены:'
Write-Host '    1) Параметры → Обновление и безопасность → Центр обновления Windows → Изменить период активности'
Write-Host '       (Windows 11: Параметры → Центр обновления Windows → Дополнительные параметры → Период активности).'
Write-Host '       Укажите рабочие часы клуба (до 18 часов подряд), в это время Windows не перезагружается.'
Write-Host '    2) Windows Pro: gpedit.msc → Конфигурация компьютера → Административные шаблоны → Компоненты Windows →'
Write-Host '       Центр обновления Windows → «Не выполнять автоматическую перезагрузку при автоматической установке'
Write-Host '       обновлений, если в системе работают пользователи» = Включено; «Настройка автоматического обновления» = 2 или 3.'
Write-Host '    3) Подключите ПК к ИБП (UPS). Подробности — в README.md.'
Write-Log 'install.ps1 finished OK'
exit 0
