param([string]$Root = "C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809\.tmp")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinCapConsole {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc proc, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hwnd);
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$windows = New-Object System.Collections.ArrayList
$script:cb = {
  param($hwnd, $param)
  if (-not [WinCapConsole]::IsWindowVisible($hwnd)) { return $true }
  $len = [WinCapConsole]::GetWindowTextLength($hwnd)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1)
  [WinCapConsole]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
  if ($title -notlike "*BepInEx*") { return $true }
  $pidWin = 0
  [WinCapConsole]::GetWindowThreadProcessId($hwnd, [ref]$pidWin) | Out-Null
  $r = New-Object WinCapConsole+RECT
  [WinCapConsole]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
  [void]$windows.Add([pscustomobject]@{ Hwnd = $hwnd; Title = $title; Pid = $pidWin; Area = $area; Rect = $r })
  return $true
}
[WinCapConsole]::EnumWindows($script:cb, [IntPtr]::Zero) | Out-Null

$i = 0
foreach ($w in $windows) {
  $proc = Get-Process -Id $w.Pid -ErrorAction SilentlyContinue
  $start = if ($proc) { $proc.StartTime } else { $null }
  Write-Output ("CONSOLE " + $i + " pid=" + $w.Pid + " start=" + $start + " area=" + $w.Area + " title=" + $w.Title)
  [WinCapConsole]::ShowWindow($w.Hwnd, 9) | Out-Null
  [WinCapConsole]::SetForegroundWindow($w.Hwnd) | Out-Null
  Start-Sleep -Milliseconds 350
  $r = New-Object WinCapConsole+RECT
  [WinCapConsole]::GetWindowRect($w.Hwnd, [ref]$r) | Out-Null
  $cw = $r.Right - $r.Left
  $ch = $r.Bottom - $r.Top
  if ($cw -le 0 -or $ch -le 0) { continue }
  $bmp = [System.Drawing.Bitmap]::new($cw, $ch)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $ok = [WinCapConsole]::PrintWindow($w.Hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $out = Join-Path $Root ("console-" + $i + ".png")
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("printwindow=" + $ok + " -> " + $out)
  $i++
}
