@echo off
rem Dev wrapper: runs the CLI against a throwaway storage.
rem   imok                 check in as ok
rem   imok alert "..."     check in asking for help
rem   imok list            what this device is carrying
rem   imok me              your identity and stats
rem   imok relay           is the background relay up
rem Override with: set IMOK_STORAGE=C:\path\to\store
setlocal
cd /d "%~dp0"
if "%IMOK_STORAGE%"=="" set "IMOK_STORAGE=%TEMP%\imok-dev"
npx bare bin.mjs %* --no-updates --storage "%IMOK_STORAGE%"
