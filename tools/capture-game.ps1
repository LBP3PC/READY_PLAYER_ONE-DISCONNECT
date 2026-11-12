Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32c {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$root = 'C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809'
$dir = Join-Path $root '.game-shot'
function Save-Shot($name) {
  $p = Get-Process RecRoom -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { "pas de fenetre RecRoom pour $name"; return }
  [void][W32c]::ShowWindow($p.MainWindowHandle, 9)
  [void][W32c]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Seconds 2
  $r = New-Object W32c+RECT
  [void][W32c]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  if ($w -lt 300 -or $h -lt 300) { "fenetre inutilisable pour $name ($w x $h)"; return }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save((Join-Path $dir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  "ecrit $name ($w x $h)"
}
Start-Sleep -Seconds 45
Save-Shot 'game-1.png'
Start-Sleep -Seconds 35
Save-Shot 'game-2.png'
Start-Sleep -Seconds 35
Save-Shot 'game-3.png'
