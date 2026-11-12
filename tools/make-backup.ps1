param([string]$List = '.tmp/backup-list.txt', [string]$Zip = 'backups/REC-BLUE-mods-2026-11-11.zip')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $Zip) { Remove-Item $Zip -Force }
$full = Join-Path (Get-Location) $Zip
$zip = [System.IO.Compression.ZipFile]::Open($full, 'Create')
foreach ($line in Get-Content $List) {
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $parts = $line.Split('|')
  $file = $parts[0].Trim(); $name = $parts[1].Trim()
  if (-not (Test-Path -LiteralPath $file)) { Write-Output ("  absent, ignore: " + $file); continue }
  $resolved = (Resolve-Path -LiteralPath $file).Path
  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $resolved, $name)
}
$zip.Dispose()
$read = [System.IO.Compression.ZipFile]::OpenRead($full)
$total = 0; $bad = 0
foreach ($e in $read.Entries) {
  $total += $e.Length
  try { $s = $e.Open(); $buf = New-Object byte[] 65536; while ($s.Read($buf, 0, $buf.Length) -gt 0) {}; $s.Dispose() }
  catch { $bad++; Write-Output ("  entree illisible: " + $e.FullName) }
}
Write-Output ("  entrees=" + $read.Entries.Count + "  octets_deplies=" + $total + "  illisibles=" + $bad)
$read.Dispose()
Write-Output ("  archive=" + (Get-Item -LiteralPath $full).Length + " octets")
Write-Output ("  sha256=" + (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash)
