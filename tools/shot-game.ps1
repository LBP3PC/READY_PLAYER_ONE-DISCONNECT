Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class G {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type @"
using System;
using System.Collections.Generic;
public class L {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  public static List<IntPtr> List() { var r = new List<IntPtr>(); EnumWindows((h,l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@

$found = $null
foreach ($h in [L]::List()) {
  if (-not [G]::IsWindowVisible($h)) { continue }
  $len = [G]::GetWindowTextLength($h)
  if ($len -le 0) { continue }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][G]::GetWindowText($h, $sb, $sb.Capacity)
  if ($sb.ToString() -match '^Rec ?Room') { $found = $h; break }
}
if (-not $found) { Write-Output "fenetre du jeu introuvable"; exit 1 }

[void][G]::ShowWindow($found, 3)
[void][G]::SetForegroundWindow($found)
Start-Sleep -Seconds 2

$r = New-Object G+RECT
[void][G]::GetWindowRect($found, [ref]$r)
$w = $r.Right - $r.Left
$h2 = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h2
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $h2))
$g.Dispose()
$path = Join-Path $PSScriptRoot "..\.game-shot\game.png"
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "ecrit game.png ($w x $h2)"
