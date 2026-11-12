$ErrorActionPreference = 'Continue'

$configPath = 'C:\RecRoom2023\BepInEx\config\net.rec.plugin.cfg'
Write-Output '=== SECTION [Photon] DU CLIENT ==='
$lines = Get-Content -LiteralPath $configPath
$start = ($lines | Select-String -Pattern '^\[Photon\]').LineNumber
if ($start) {
	$lines[($start - 1)..([Math]::Min($lines.Count - 1, $start + 24))] | ForEach-Object { $_ }
} else {
	Write-Output 'SECTION [Photon] ABSENTE'
}

Write-Output '=== VALEURS PHOTON CLIENT ==='
$lines | Select-String -Pattern 'Photon Realtime App ID|Photon Voice App ID|Photon Chat App ID|Photon Region|Photon NameServer|Enabled Advanced Settings' | ForEach-Object { $_.Line }

Write-Output '=== PLAYERPREFS REGION ==='
foreach ($key in @('HKCU:\Software\Against Gravity\Rec Room', 'HKCU:\Software\Against Gravity\RecRoom', 'HKCU:\Software\Unity\UnityEditor\DefaultCompany\Rec Room')) {
	if (Test-Path -LiteralPath $key) {
		Write-Output "CLE: $key"
		Get-ItemProperty -LiteralPath $key | Select-Object PUNCloudBestRegion, PUNCloudRegion, *Photon* | Format-List
	}
}
Write-Output '=== RECHERCHE REGISTRE PUNCloudBestRegion ==='
Get-ChildItem 'HKCU:\Software' -ErrorAction SilentlyContinue | ForEach-Object {
	$sub = $_
	Get-ChildItem $sub.PSPath -ErrorAction SilentlyContinue | ForEach-Object {
		$props = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
		if ($props -and ($props.PSObject.Properties.Name -contains 'PUNCloudBestRegion')) {
			Write-Output "$($_.PSPath) => $($props.PUNCloudBestRegion)"
		}
	}
}
