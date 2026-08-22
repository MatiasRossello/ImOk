@echo off
rem Run one peer in the foreground with its own storage.
rem   peer ana "estoy bien"   writes a note, then relays
rem   peer beto               relays only, writes nothing
setlocal
cd /d "%~dp0"
if "%~1"=="" (echo usage: peer ^<name^> [note] ^& exit /b 1)
if "%~2"=="" (
  npx bare bin.mjs relay --foreground --no-updates --storage "%TEMP%\imok-%~1"
) else (
  npx bare bin.mjs relay --foreground --no-updates --storage "%TEMP%\imok-%~1" --say "%~2"
)
