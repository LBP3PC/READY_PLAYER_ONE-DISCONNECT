@echo off
rem ---------------------------------------------------------------------------
rem REC BLUE - sauvegarde quotidienne
rem Declenche le Worker recblue-backup, qui archive la base D1 et les reglages
rem joueurs dans Cloudflare (retention 7 jours cote worker).
rem
rem Installe par une tache planifiee Windows : une copie de ce fichier vit dans
rem %USERPROFILE%\REC-BLUE-sauvegarde\ et c'est celle-la qui s'execute.
rem ---------------------------------------------------------------------------
setlocal
set "URL=https://recblue-backup.recblue.workers.dev/run"
set "KEYFILE=%USERPROFILE%\.recblue-backup-key"
set "LOGDIR=%USERPROFILE%\REC-BLUE-sauvegarde"
set "LOG=%LOGDIR%\journal.txt"

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

if not exist "%KEYFILE%" (
  echo %DATE% %TIME% ERREUR : cle de declenchement absente >> "%LOG%"
  exit /b 1
)

set /p KEY=<"%KEYFILE%"
if "%KEY%"=="" (
  echo %DATE% %TIME% ERREUR : cle de declenchement vide >> "%LOG%"
  exit /b 1
)

for /f "delims=" %%R in ('curl -s --max-time 600 -X POST "%URL%" -H "x-backup-key: %KEY%"') do set "RES=%%R"

if "%RES%"=="" (
  echo %DATE% %TIME% ECHEC : pas de reponse du serveur de sauvegarde >> "%LOG%"
  exit /b 1
)

echo %DATE% %TIME% OK %RES%>> "%LOG%"
endlocal
