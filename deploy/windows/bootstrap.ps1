#Requires -Version 5.1
<#
.SYNOPSIS
  Установка TS HUB одной строкой (скачивает архив репозитория и запускает install.ps1).

.DESCRIPTION
  В PowerShell ОТ АДМИНИСТРАТОРА:
    irm https://raw.githubusercontent.com/ansa-music/billS/main/deploy/windows/bootstrap.ps1 | iex

  Параметры передаются через переменные окружения (у irm|iex нет аргументов):
    $env:BILLS_REF  = 'main'      # ветка, тег или commit
    $env:BILLS_ROOT = 'C:\bills'  # папка установки
    $env:BILLS_HOST = '0.0.0.0'
    $env:BILLS_PORT = '4310'
  Предпочтительный путь всё же — скачать zip/клонировать репозиторий и запустить deploy\windows\install.ps1 вручную:
  так видно, что именно выполняется.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Ref = 'main'
if ($env:BILLS_REF) { $Ref = $env:BILLS_REF }
$Root = 'C:\bills'
if ($env:BILLS_ROOT) { $Root = $env:BILLS_ROOT }
$HubHost = '0.0.0.0'
if ($env:BILLS_HOST) { $HubHost = $env:BILLS_HOST }
$Port = '4310'
if ($env:BILLS_PORT) { $Port = $env:BILLS_PORT }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'ОШИБКА: запустите PowerShell от имени администратора.' -ForegroundColor Red
    exit 1
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path $env:TEMP "bills-bootstrap-$stamp"
New-Item -ItemType Directory -Path $work -Force | Out-Null
$zip = Join-Path $work 'repo.zip'
$url = "https://github.com/ansa-music/billS/archive/$Ref.zip"

Write-Host "==> Скачиваю $url" -ForegroundColor Cyan
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
Write-Host '==> Распаковываю' -ForegroundColor Cyan
Expand-Archive -LiteralPath $zip -DestinationPath $work -Force
$installer = @(Get-ChildItem -LiteralPath $work -Recurse -Filter 'install.ps1' | Where-Object { $_.DirectoryName -like '*deploy\windows' })
if ($installer.Count -eq 0) {
    Write-Host "ОШИБКА: в архиве нет deploy\windows\install.ps1 (ref '$Ref')." -ForegroundColor Red
    exit 1
}
$installPath = $installer[0].FullName
Write-Host "==> Запускаю $installPath" -ForegroundColor Cyan
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installPath -Ref $Ref -Root $Root -HubHost $HubHost -Port $Port
$code = $LASTEXITCODE
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
exit $code
