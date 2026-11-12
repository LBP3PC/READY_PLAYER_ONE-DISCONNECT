param([string]$Zip = 'backups/REC-BLUE-mods-2026-11-11.zip')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$full = Join-Path (Get-Location) $Zip
$read = [System.IO.Compression.ZipFile]::OpenRead($full)
$total = 0; $bad = 0
foreach ($e in $read.Entries) {
  $total += $e.Length
  try { $s = $e.Open(); $buf = New-Object byte[] 65536; while ($s.Read($buf, 0, $buf.Length) -gt 0) {}; $s.Dispose() }
  catch { $bad++ }
}
foreach ($e in $read.Entries) { Write-Output ("  {0,9} o  {1}" -f $e.Length, $e.FullName) }
Write-Output ("entrees=" + $read.Entries.Count + "  octets_deplies=" + $total + "  illisibles=" + $bad)
$read.Dispose()
Write-Output ("archive=" + (Get-Item -LiteralPath $full).Length + " octets")
Write-Output ("sha256=" + (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash)
