Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32d {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$dir = 'C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809\.game-shot'
function Shot($name) {
  $p = Get-Process RecRoom -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { "pas de fenetre pour $name"; return }
  [void][W32d]::ShowWindow($p.MainWindowHandle, 9)
  [void][W32d]::SetForegroundWindow($p.MainWindowHandle)
  Start-Sleep -Milliseconds 900
  $r = New-Object W32d+RECT
  [void][W32d]::GetWindowRect($p.MainWindowHandle, [ref]$r)
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  if ($w -lt 300 -or $h -lt 300) { "fenetre inutilisable $name ($w x $h)"; return }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $small = New-Object System.Drawing.Bitmap(960, [int]($h * 960 / $w))
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $small.Width, $small.Height)
  $g2.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 78)
  $small.Save((Join-Path $dir ($name + '.jpg')), $codec, $params)
  $small.Dispose(); $bmp.Dispose()
  "ecrit $name.jpg ($w x $h)"
}
Start-Sleep -Seconds 16
Shot 't1'
Start-Sleep -Seconds 7
Shot 't2'
Start-Sleep -Seconds 12
Shot 't3'
