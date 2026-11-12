$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$p = Get-Process -Name 'REC-BLUE-Launcher' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Output 'NO_LAUNCHER'; exit 1 }
$h = $p.MainWindowHandle
$r = New-Object LCap+RECT
[void][LCap]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
Write-Output "hwnd=$h pos=$($r.Left),$($r.Top) size=${w}x${ht} title=$($p.MainWindowTitle)"
$b = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($b)
$dc = $g.GetHdc()
[void][LCap]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$b.Save((Join-Path (Get-Location) '.game-shot/launcher.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose()
Write-Output 'saved'
