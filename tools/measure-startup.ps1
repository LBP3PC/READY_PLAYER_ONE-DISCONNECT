$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class SW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> All() { var l = new List<IntPtr>(); EnumWindows((h, p) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@

$exe = 'C:\RecRoom2023\REC-BLUE-Launcher.exe'
for ($run = 1; $run -le 2; $run++) {
  Get-Process 'REC-BLUE-Launcher' -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Milliseconds 400
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath $exe -PassThru
  $h = [IntPtr]::Zero
  while ($sw.Elapsed.TotalSeconds -lt 8.0 -and $h -eq [IntPtr]::Zero) {
    Start-Sleep -Milliseconds 10
    foreach ($w in [SW]::All()) {
      $pidWin = [uint32]0
      [void][SW]::GetWindowThreadProcessId($w, [ref]$pidWin)
      if ($pidWin -eq $p.Id -and [SW]::IsWindowVisible($w)) {
        $r = New-Object SW+RECT
        [void][SW]::GetWindowRect($w, [ref]$r)
        if (($r.Right - $r.Left) -ge 500) { $h = $w; break }
      }
    }
  }
  if ($h -eq [IntPtr]::Zero) {
    Write-Output ("run $run : NO_WINDOW apres " + $sw.ElapsedMilliseconds + " ms")
  } else {
    Write-Output ("run $run : fenetre visible apres " + $sw.ElapsedMilliseconds + " ms, responding=" + $p.Responding)
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
}
