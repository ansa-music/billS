# common.ps1 — общие функции для скриптов развёртывания TS под Windows.
# Подключается через dot-source: . (Join-Path $PSScriptRoot 'common.ps1')
# Совместимо с Windows PowerShell 5.1.

Set-StrictMode -Version Latest

$script:HubTaskName = 'billS HUB'
$script:BackupTaskName = 'billS Backup'
$script:NssmServiceName = 'billS-HUB'
$script:FirewallRuleName = 'billS HUB (LAN)'
$script:RepoUrl = 'https://github.com/ansa-music/billS.git'
$script:BillsLogFile = $null

function Write-Step {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host ''
    Write-Host "==> $Message" -ForegroundColor Cyan
    Write-Log "STEP $Message"
}

function Write-Info {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "    $Message"
    Write-Log "INFO $Message"
}

function Write-Warn {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Host "    ВНИМАНИЕ: $Message" -ForegroundColor Yellow
    Write-Log "WARN $Message"
}

function Fail {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$ExitCode = 1
    )
    Write-Host ''
    Write-Host "ОШИБКА: $Message" -ForegroundColor Red
    Write-Log "FAIL $Message"
    exit $ExitCode
}

function Set-BillsLog {
    # Включает дублирование сообщений в файл (Add-Content с датой).
    param([Parameter(Mandatory = $true)][string]$Path)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $script:BillsLogFile = $Path
}

function Write-Log {
    param([Parameter(Mandatory = $true)][string]$Message)
    if (-not $script:BillsLogFile) { return }
    try {
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -LiteralPath $script:BillsLogFile -Value "$stamp $Message" -Encoding UTF8
    } catch {
        # Лог не должен ронять основную операцию.
    }
}

function Get-BillsPaths {
    param([Parameter(Mandatory = $true)][string]$Root)
    $app = Join-Path $Root 'app'
    $data = Join-Path $Root 'data'
    $bin = Join-Path $Root 'bin'
    return [pscustomobject]@{
        Root     = $Root
        App      = $app
        Data     = $data
        Backups  = Join-Path $Root 'backups'
        Logs     = Join-Path $Root 'logs'
        Bin      = $bin
        EnvFile  = Join-Path $app '.env'
        DbPath   = Join-Path $data 'hub.db'
        Marker   = Join-Path $data 'last-backup.json'
        HubMain  = Join-Path $app 'apps\hub\src\main.ts'
        HubCli   = Join-Path $app 'apps\hub\src\cli.ts'
        RunCmd   = Join-Path $bin 'run-hub.cmd'
    }
}

function Update-PathFromRegistry {
    # После winget install текущий процесс не видит новый PATH — перечитываем из реестра.
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Resolve-NodeExe {
    # Возвращает полный путь к node.exe или $null.
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $bases = @()
    foreach ($name in @('ProgramFiles', 'ProgramFiles(x86)')) {
        $v = [Environment]::GetEnvironmentVariable($name)
        if ($v) { $bases += (Join-Path $v 'nodejs') }
    }
    $local = [Environment]::GetEnvironmentVariable('LOCALAPPDATA')
    if ($local) { $bases += (Join-Path $local 'Programs\nodejs') }
    foreach ($b in $bases) {
        $c = Join-Path $b 'node.exe'
        if (Test-Path -LiteralPath $c) { return $c }
    }
    return $null
}

function Invoke-Native {
    <#
      Запускает внешнюю программу и возвращает объект { ExitCode; Output }.
      $ErrorActionPreference временно переводится в Continue: в PowerShell 5.1
      при 'Stop' любая строка в stderr внешней программы превращается в исключение.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$WorkingDirectory = $null,
        [switch]$Capture
    )
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $pushed = $false
    $output = @()
    $code = -1
    try {
        if ($WorkingDirectory) {
            Push-Location -LiteralPath $WorkingDirectory
            $pushed = $true
        }
        if ($Capture) {
            $output = @(& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" })
        } else {
            & $FilePath @Arguments
        }
        $code = $LASTEXITCODE
    } finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $prev
    }
    return [pscustomobject]@{ ExitCode = $code; Output = $output }
}

function Get-EnvValue {
    # Читает KEY=value из .env (без кавычек и подстановок). Возвращает $Default, если ключа нет.
    param(
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [Parameter(Mandatory = $true)][string]$Key,
        [string]$Default = ''
    )
    if (-not (Test-Path -LiteralPath $EnvFile)) { return $Default }
    $lines = @(Get-Content -LiteralPath $EnvFile -ErrorAction SilentlyContinue)
    foreach ($line in $lines) {
        $trimmed = "$line".Trim()
        if ($trimmed.StartsWith('#')) { continue }
        if ($trimmed -match ('^' + [regex]::Escape($Key) + '\s*=\s*(.*)$')) {
            $value = $Matches[1].Trim()
            if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
                $value = $value.Substring(1, $value.Length - 2)
            }
            return $value
        }
    }
    return $Default
}

function Get-HubPort {
    param([Parameter(Mandatory = $true)]$Paths)
    $raw = Get-EnvValue -EnvFile $Paths.EnvFile -Key 'HUB_PORT' -Default '4310'
    $port = 0
    if ([int]::TryParse($raw, [ref]$port) -and $port -gt 0) { return $port }
    return 4310
}

function Test-NssmService {
    $svc = Get-Service -Name $script:NssmServiceName -ErrorAction SilentlyContinue
    if ($svc) { return $true }
    return $false
}

function Get-HubProcesses {
    # Процессы HUB: cmd.exe с run-hub.cmd и node.exe, запущенный из папки приложения с main.ts.
    param([Parameter(Mandatory = $true)]$Paths)
    $appPattern = [regex]::Escape($Paths.App)
    $all = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" -ErrorAction SilentlyContinue)
    $result = @()
    foreach ($p in $all) {
        $cl = $p.CommandLine
        if (-not $cl) { continue }
        if ($p.Name -ieq 'cmd.exe' -and $cl -match 'run-hub\.cmd') { $result += $p; continue }
        if ($p.Name -ieq 'node.exe' -and $cl -match $appPattern -and $cl -match 'main\.ts') { $result += $p }
    }
    return $result
}

function Stop-Hub {
    # Останавливает HUB: задача Планировщика (или служба NSSM), затем добивает оставшиеся процессы.
    param([Parameter(Mandatory = $true)]$Paths)
    if (Test-NssmService) {
        Write-Info "Найдена служба $($script:NssmServiceName) — останавливаю службу."
        Stop-Service -Name $script:NssmServiceName -Force -ErrorAction SilentlyContinue
    } else {
        $task = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
        if ($task) {
            if ($task.State -eq 'Running') {
                Stop-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
            }
        } else {
            Write-Warn "Задача Планировщика '$($script:HubTaskName)' не найдена."
        }
    }

    # Сначала cmd.exe (иначе обёртка перезапустит node), потом node.exe.
    $procs = @(Get-HubProcesses -Paths $Paths)
    $ordered = @($procs | Where-Object { $_.Name -ieq 'cmd.exe' }) + @($procs | Where-Object { $_.Name -ieq 'node.exe' })
    foreach ($p in $ordered) {
        Write-Info "Завершаю процесс $($p.Name) PID $($p.ProcessId)"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }

    $port = Get-HubPort -Paths $Paths
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        $left = @(Get-HubProcesses -Paths $Paths)
        $listening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0 -and $listening.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    $left = @(Get-HubProcesses -Paths $Paths)
    if ($left.Count -gt 0) {
        Fail "Не удалось остановить процессы HUB (PID: $(($left | ForEach-Object { $_.ProcessId }) -join ', '))."
    }
    Write-Info 'HUB остановлен.'
}

function Start-Hub {
    param([Parameter(Mandatory = $true)]$Paths)
    if (Test-NssmService) {
        Write-Info "Запускаю службу $($script:NssmServiceName)."
        Start-Service -Name $script:NssmServiceName
        return
    }
    $task = Get-ScheduledTask -TaskName $script:HubTaskName -ErrorAction SilentlyContinue
    if (-not $task) { Fail "Задача Планировщика '$($script:HubTaskName)' не найдена. Запустите install.ps1." }
    if ($task.State -eq 'Disabled') {
        Enable-ScheduledTask -TaskName $script:HubTaskName | Out-Null
    }
    Start-ScheduledTask -TaskName $script:HubTaskName
    Write-Info "Задача '$($script:HubTaskName)' запущена."
}

function Get-HubHealth {
    param([Parameter(Mandatory = $true)][int]$Port)
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
        if ($r -and $r.PSObject.Properties['ok'] -and $r.ok) { return $r }
    } catch {
        # ещё не поднялся
    }
    return $null
}

function Wait-HubHealth {
    # Ждёт /api/health с ok:true. Возвращает ответ или $null по таймауту.
    param(
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutSec = 60
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    Write-Host '    ожидание HUB ' -NoNewline
    while ((Get-Date) -lt $deadline) {
        $h = Get-HubHealth -Port $Port
        if ($h) {
            Write-Host ' готов'
            return $h
        }
        Write-Host '.' -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ' таймаут'
    return $null
}

function Format-Health {
    param([Parameter(Mandatory = $true)]$Health)
    $parts = @()
    foreach ($name in @('version', 'uptimeSeconds', 'lastBackupAt', 'freeDiskBytes')) {
        $prop = $Health.PSObject.Properties[$name]
        if ($prop) {
            $value = $prop.Value
            if ($name -eq 'freeDiskBytes' -and $value) { $value = ('{0:N1} ГБ' -f ($value / 1GB)) }
            $parts += "$name=$value"
        }
    }
    if ($parts.Count -eq 0) { return 'ok=true' }
    return ($parts -join ', ')
}

function Set-GitRef {
    # git fetch + checkout <ref>. Ветка — сбрасывается на origin/<ref>; тег или sha — detached.
    param(
        [Parameter(Mandatory = $true)][string]$RepoDir,
        [Parameter(Mandatory = $true)][string]$Ref
    )
    $r = Invoke-Native -FilePath 'git' -Arguments @('fetch', '--tags', '--prune', 'origin') -WorkingDirectory $RepoDir
    if ($r.ExitCode -ne 0) { Fail "git fetch завершился с кодом $($r.ExitCode)." }
    $probe = Invoke-Native -FilePath 'git' -Arguments @('rev-parse', '--verify', '--quiet', "refs/remotes/origin/$Ref") -WorkingDirectory $RepoDir -Capture
    if ($probe.ExitCode -eq 0) {
        $r = Invoke-Native -FilePath 'git' -Arguments @('checkout', '-q', '-f', '-B', $Ref, "origin/$Ref") -WorkingDirectory $RepoDir
    } else {
        $r = Invoke-Native -FilePath 'git' -Arguments @('checkout', '-q', '-f', '--detach', $Ref) -WorkingDirectory $RepoDir
    }
    if ($r.ExitCode -ne 0) { Fail "git checkout '$Ref' завершился с кодом $($r.ExitCode)." }
}

function Get-GitSha {
    param([Parameter(Mandatory = $true)][string]$RepoDir)
    $r = Invoke-Native -FilePath 'git' -Arguments @('rev-parse', 'HEAD') -WorkingDirectory $RepoDir -Capture
    if ($r.ExitCode -ne 0 -or $r.Output.Count -eq 0) { return $null }
    return "$($r.Output[0])".Trim()
}

function Install-AppDependencies {
    # npm ci + сборка экрана зала. Возвращает $true/$false (вызывающий решает, падать или откатываться).
    param([Parameter(Mandatory = $true)]$Paths)
    Write-Step 'npm ci (установка зависимостей)'
    $r = Invoke-Native -FilePath 'npm' -Arguments @('ci', '--no-audit', '--no-fund') -WorkingDirectory $Paths.App
    if ($r.ExitCode -ne 0) {
        Write-Warn "npm ci завершился с кодом $($r.ExitCode)."
        return $false
    }
    Write-Step 'Сборка экрана зала (npm run build -w @bills/web)'
    $r = Invoke-Native -FilePath 'npm' -Arguments @('run', 'build', '-w', '@bills/web') -WorkingDirectory $Paths.App
    if ($r.ExitCode -ne 0) {
        Write-Warn "Сборка @bills/web завершилась с кодом $($r.ExitCode)."
        return $false
    }
    return $true
}

function Copy-DeployScripts {
    # Копирует скрипты развёртывания в <Root>\bin (оттуда их запускают задачи Планировщика).
    param(
        [Parameter(Mandatory = $true)]$Paths,
        [Parameter(Mandatory = $true)][string]$SourceDir
    )
    if (-not (Test-Path -LiteralPath $Paths.Bin)) {
        New-Item -ItemType Directory -Path $Paths.Bin -Force | Out-Null
    }
    $files = @(Get-ChildItem -LiteralPath $SourceDir -File | Where-Object { $_.Extension -in @('.ps1', '.cmd') -or $_.Name -eq 'hub.env.example' })
    foreach ($f in $files) {
        Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $Paths.Bin $f.Name) -Force
    }
    Write-Info "Скрипты скопированы в $($Paths.Bin) ($($files.Count) файлов)."
}

function Get-LanAddresses {
    $addrs = @()
    try {
        $all = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)
        foreach ($a in $all) {
            $ip = $a.IPAddress
            if ($ip -like '127.*' -or $ip -like '169.254.*') { continue }
            $addrs += $ip
        }
    } catch {
        # без сетевых адаптеров — просто пусто
    }
    return $addrs
}
