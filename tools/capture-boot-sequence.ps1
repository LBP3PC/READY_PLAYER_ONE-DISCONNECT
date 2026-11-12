$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win3 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@

Get-Process RecRoom -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
Start-Process -FilePath 'C:\RecRoom2023\RecRoom.exe' -WorkingDirectory 'C:\RecRoom2023'

$shots = 0
for ($t = 0; $t -lt 40; $t++) {
  Start-Sleep -Milliseconds 700
  $p = Get-Process RecRoom -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { continue }
  $r = New-Object RECT
  [Win3]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -lt 400 -or $h -lt 300) { continue }
  $shots++
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $bmp.Save((Join-Path (Get-Location) (".tmp/boot-{0:d2}.png" -f $shots)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("boot {0:d2} a {1} ms" -f $shots, (700 * $t))
  if ($shots -ge 14) { break }
}
Write-Output ("total {0} captures" -f $shots)
