Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$targets = New-Object System.Collections.ArrayList
$proc = Get-Process RecRoom, Recroom_Release -ErrorAction SilentlyContinue
foreach ($p in $proc) {
  foreach ($h in $p.MainWindowHandle, ($p.Threads | ForEach-Object { $_ })) { }
  $handle = $p.MainWindowHandle
  if ($handle -ne [IntPtr]::Zero) { [void]$targets.Add($handle) }
}

# enumeration complete, on garde les fenetres visibles de taille raisonnable
$all = New-Object System.Collections.ArrayList
$cb = [Delegate]::CreateDelegate([Func[IntPtr, bool]], @{})
Add-Type @"
using System;
using System.Collections.Generic;
public class E {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  public static List<IntPtr> List(IntPtr[] ignored) { var r = new List<IntPtr>(); EnumWindows((h,l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@
foreach ($h in [E]::List(@())) {
  if (-not [W]::IsWindowVisible($h)) { continue }
  $len = [W]::GetWindowTextLength($h)
  if ($len -le 0) { continue }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][W]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -lt 400 -or $hh -lt 300) { continue }
  if ($title -match 'Rec ?Room|REC BLUE') { [void]$targets.Add($h); Write-Output "candidat: $title ${w}x${hh}" }
}

$i = 0
foreach ($h in $targets) {
  $r = New-Object W+RECT
  [void][W]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  if ($w -lt 400 -or $hh -lt 300) { continue }
  [void][W]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 900
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  [void][W]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc)
  $g.Dispose()
  $i++
  $path = Join-Path $PSScriptRoot ("..\.game-shot\w$i.png")
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "ecrit w$i.png ($w x $hh)"
}
