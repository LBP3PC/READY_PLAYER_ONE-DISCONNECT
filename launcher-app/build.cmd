@echo off
rem Recompile le launcher REC BLUE (application C# autonome).
rem Le logo officiel du site est embarque dans l'exe : aucun fichier a cote.
rem Le manifeste app.manifest et les attributs d'assemblee donnent a l'exe son identite
rem (nom, editeur, version) : sans eux Windows Defender le classe en Trojan et le supprime.
cd /d "%~dp0"
"%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe" -nologo -target:winexe -out:REC-BLUE-Launcher.exe -win32manifest:app.manifest -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.Management.dll -resource:RecBlueLogo.png,RecBlueLogo.png -resource:RecBlueTitleWinter.png,RecBlueTitleWinter.png -resource:RecBlueBackdrop.png,RecBlueBackdrop.png RecBlueLauncher.cs
if errorlevel 1 (echo COMPILATION ECHOUEE & goto :fin)
echo REC-BLUE-Launcher.exe mis a jour
rem Archive le build sur le site (copie versionnee, fiche SHA-256, ligne "Versions archivees")
rem puis publie le site. Utiliser build.cmd --no-deploy pour rester en local.
set "ARCHIVE_ARGS="
if /I not "%~1"=="--no-deploy" set "ARCHIVE_ARGS=--deploy"
set "NODE=%~dp0..\.tools\node-v22.23.4-win-x64\node.exe"
if not exist "%NODE%" set "NODE=node"
rem 1) copie versionnee + fiche d'empreinte, 2) sauvegarde decoupee du site complet
rem puis publication unique (le second script porte --deploy).
"%NODE%" "%~dp0..\hosting\scripts\launcher-archive.mjs"
if errorlevel 1 echo ARCHIVE ECHOUEE - voir le message ci-dessus.
"%NODE%" "%~dp0..\hosting\scripts\launcher-backup.mjs" %ARCHIVE_ARGS%
if errorlevel 1 echo SAUVEGARDE OU PUBLICATION ECHOUEE - voir le message ci-dessus.
:fin
pause
