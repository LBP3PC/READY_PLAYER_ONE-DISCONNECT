$ErrorActionPreference = 'SilentlyContinue'
$exe = 'C:\RecRoom2023-20231219\RecRoom.exe'
$wd = 'C:\RecRoom2023-20231219'
Get-Process RecRoom -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
$p = Start-Process -FilePath $exe -WorkingDirectory $wd -PassThru
Write-Output ("pid=" + $p.Id)
$seen = @{}
for ($i = 0; $i -lt 120; $i++) {
    $conns = Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        $key = "$($c.State) $($c.RemoteAddress):$($c.RemotePort)"
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            Write-Output ("t=" + [math]::Round($i * 0.5, 1) + "s " + $key)
        }
    }
    Start-Sleep -Milliseconds 500
}
Write-Output '=== fin trace ==='
