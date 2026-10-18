@echo off
setlocal EnableExtensions
rem billS HUB wrapper for Task Scheduler.
rem Usage: run-hub.cmd [ROOT] [NODE_EXE]
rem   ROOT     - install root (default: parent of this script's folder, e.g. C:\bills)
rem   NODE_EXE - full path to node.exe (default: node from PATH)
rem Runs the HUB in a loop: if node exits for any reason, waits 3 s and starts it again.
rem Rotates hub.log once it grows past 20 MB (one previous generation: hub.1.log).
rem Keep this file ASCII-only: cmd.exe uses the OEM code page.

if "%~1"=="" (
  for %%I in ("%~dp0..") do set "ROOT=%%~fI"
) else (
  set "ROOT=%~1"
)
if "%~2"=="" (
  set "NODE=node"
) else (
  set "NODE=%~2"
)

set "APP=%ROOT%\app"
set "LOGDIR=%ROOT%\logs"
set "LOG=%LOGDIR%\hub.log"
set "LOG1=%LOGDIR%\hub.1.log"
set "ENVFILE=%APP%\.env"
set "MAXBYTES=20971520"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if not exist "%APP%\apps\hub\src\main.ts" (
  echo [%date% %time%] run-hub: main.ts not found under "%APP%" >> "%LOG%"
  exit /b 2
)

cd /d "%APP%"

:loop
if exist "%LOG%" (
  for %%F in ("%LOG%") do (
    if %%~zF GTR %MAXBYTES% (
      if exist "%LOG1%" del /q "%LOG1%"
      move /y "%LOG%" "%LOG1%" > nul
    )
  )
)
echo [%date% %time%] run-hub: starting HUB (root=%ROOT%) >> "%LOG%"
"%NODE%" --env-file-if-exists="%ENVFILE%" apps\hub\src\main.ts >> "%LOG%" 2>&1
set "CODE=%ERRORLEVEL%"
echo [%date% %time%] run-hub: HUB exited with code %CODE%, restarting in 3 s >> "%LOG%"
rem ping is used instead of timeout: timeout fails when there is no console (Task Scheduler).
ping -n 4 127.0.0.1 > nul
goto loop
