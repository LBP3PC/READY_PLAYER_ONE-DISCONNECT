Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type @"
using System;
using System.Collections.Generic;
public class EN {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  public static List<IntPtr> List() { var r = new List<IntPtr>(); EnumWindows((h,l) => { r.Add(h); return true; }, IntPtr.Zero); return r; }
}
"@

$hwnd = [IntPtr]::Zero
foreach ($h in [EN]::List()) {
  $len = [F]::GetWindowTextLength($h)
  if ($len -le 0) { continue }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][F]::GetWindowText($h, $sb, $sb.Capacity)
  if ($sb.ToString() -match '^Rec ?Room') { $hwnd = $h; break }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Output "fenetre introuvable"; exit 1 }
Write-Output ("fenetre trouvee, visible={0} minimisee={1}" -f [F]::IsWindowVisible($hwnd), [F]::IsIconic($hwnd))

if ([F]::IsIconic($hwnd)) { Write-Output "fenetre minimisee -> restauration"; [void][F]::ShowWindow($hwnd, 9) }
[void][F]::ShowWindow($hwnd, 5)
[void][F]::BringWindowToTop($hwnd)

$pid2 = 0
$thread = [F]::GetWindowThreadProcessId($hwnd, [ref]$pid2)
$current = [F]::GetCurrentThreadId()
[void][F]::AttachThreadInput($current, $thread, $true)
[void][F]::SetForegroundWindow($hwnd)
[void][F]::SetWindowPos($hwnd, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0043)
[void][F]::AttachThreadInput($current, $thread, $false)
Start-Sleep -Seconds 3

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, (New-Object System.Drawing.Size $bounds.Width, $bounds.Height))
$g.Dispose()
$bmp.Save((Join-Path $PSScriptRoot "..\.game-shot\full.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("ecrit full.png ({0}x{1}) premier plan={2}" -f $bounds.Width, $bounds.Height, ([F]::GetForegroundWindow() -eq $hwnd))
