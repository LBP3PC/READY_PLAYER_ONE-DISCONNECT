#!/usr/bin/env bash
# Met la fenetre "Rec Room" au premier plan, puis capture sa zone exacte.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="${1:-.game-shot/shot.png}"
FF="/c/Users/zanin/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffmpeg.exe"

powershell -NoProfile -Command "\$w = New-Object -ComObject WScript.Shell; [void]\$w.AppActivate('Rec Room'); Start-Sleep -Seconds 2" >/dev/null 2>&1

RECT=$(powershell -NoProfile -ExecutionPolicy Bypass -File .tmp/rect.ps1 2>/dev/null | tail -1)
echo "rect: $RECT"
set -- $RECT
if [ "${1:-NONE}" = "NONE" ]; then
  echo "fenetre introuvable"
  exit 1
fi

"$FF" -hide_banner -loglevel error -f gdigrab -framerate 1 -offset_x "$1" -offset_y "$2" -video_size "${3}x${4}" -i desktop -frames:v 1 -y "$OUT" || exit 1
SMALL="${OUT%.png}-small.png"
"$FF" -hide_banner -loglevel error -i "$OUT" -vf scale=900:-1 -y "$SMALL"
ls -la "$SMALL"
