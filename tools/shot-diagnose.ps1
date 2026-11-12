Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class D {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
}
"@
Add-Type @"
using System;
using System.Collections.Generic;
public class DX {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  public static List<IntPtr> List() { var r = new List<IntPtr>(); EnumWindows((h,l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@

$hwnd = [IntPtr]::Zero
foreach ($h in [DX]::List()) {
  $len = [D]::GetWindowTextLength($h)
  if ($len -le 0) { continue }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][D]::GetWindowText($h, $sb, $sb.Capacity)
  if ($sb.ToString() -match '^Rec ?Room') { $hwnd = $h; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "fenetre introuvable"; exit 1 }

function Shot([string]$name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, (New-Object System.Drawing.Size $b.Width, $b.Height))
  $g.Dispose()
  $path = Join-Path $PSScriptRoot ("..\.game-shot\" + $name)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  # mesure de blancheur echantillonnee
  $white = 0; $total = 0
  for ($y = 0; $y -lt $b.Height; $y += 40) {
    for ($x = 0; $x -lt $b.Width; $x += 40) {
      $p = $bmp.GetPixel($x, $y)
      $total++
      if ($p.R -gt 240 -and $p.G -gt 240 -and $p.B -gt 240) { $white++ }
    }
  }
  $bmp.Dispose()
  Write-Output ("{0} : {1}% de blanc echantillonne" -f $name, [math]::Round(100 * $white / [math]::Max(1, $total)))
}

[void][D]::ShowWindow($hwnd, 6)
Start-Sleep -Seconds 2
Shot "diag-minimise.png"

[void][D]::ShowWindow($hwnd, 9)
Start-Sleep -Seconds 1
[void][D]::SetForegroundWindow($hwnd)
Start-Sleep -Seconds 3
Shot "diag-jeu.png"
