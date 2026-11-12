$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win2 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
"@

Get-Process RecRoom -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3

$log = 'C:\RecRoom2023\BepInEx\LogOutput.log'
if (Test-Path $log) { Remove-Item $log -Force }
Start-Process -FilePath 'C:\RecRoom2023\RecRoom.exe' -WorkingDirectory 'C:\RecRoom2023'

$waits = @(6, 10, 14, 18, 23, 30)
$i = 0
foreach ($w in $waits) {
  Start-Sleep -Seconds $w
  $i++
  $p = Get-Process RecRoom -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { Write-Output "frame $i : fenetre absente"; continue }
  [Win2]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
  [Win2]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 600
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $out = Join-Path (Get-Location) (".tmp/frame-$i.png")
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("frame {0} apres {1}s : {2}" -f $i, $w, $out)
}
