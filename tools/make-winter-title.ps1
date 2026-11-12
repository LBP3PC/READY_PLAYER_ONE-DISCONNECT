param(
    [string]$InputPath = "C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809\launcher-app\RecBlueTitle.png",
    [string]$OutputPath = "C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809\launcher-app\RecBlueTitle.winter.png",
    [string]$PreviewPath = "C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809\.game-shot\winter-title-preview.jpg"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Bitmap]::FromFile($InputPath)
$w = $src.Width
$h = $src.Height
$out = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($out)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, $w, $h)

$rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
$data = $src.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$src.UnlockBits($data)

function Get-Alpha([int]$x, [int]$y) {
    return [int]$bytes[($y * $stride) + ($x * 4) + 3]
}

$snowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 249, 253, 255))
$snowShadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(205, 181, 222, 247))
$iceBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 225, 245, 255))
$icePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 126, 191, 231), 1.8)

# Neige sur toute la crête du logo : chaque colonne reçoit un petit amas blanc
# qui suit le contour des lettres, avec une ombre bleu glacier.
for ($x = 0; $x -lt $w; $x++) {
    $inside = $false
    $runHeight = 0
    for ($y = 0; $y -lt $h; $y++) {
        $a = Get-Alpha $x $y
        if (-not $inside -and $a -ge 96) {
            $inside = $true
            $runHeight = 0
            $wave = ([Math]::Sin($x * 0.061) * 3.2) + ([Math]::Sin($x * 0.21) * 1.6)
            $capW = 23.0
            $capH = 17.0 + $wave
            $g.FillEllipse($snowShadowBrush, [float]($x - 11.5), [float]($y - 7.0), [float]$capW, 16.0)
            $g.FillEllipse($snowBrush, [float]($x - 11.5), [float]($y - 12.5 - ($wave / 3.0)), [float]$capW, [float]$capH)
        }
        elseif ($inside -and $a -lt 96) {
            $inside = $false
            if (($x % 31) -eq 0 -and $runHeight -gt 35) {
                $len = 9.0 + (($x * 17) % 21)
                $path = New-Object System.Drawing.Drawing2D.GraphicsPath
                $path.AddPolygon([System.Drawing.PointF[]]@(
                    (New-Object System.Drawing.PointF([float]($x - 6), [float]($y - 2))),
                    (New-Object System.Drawing.PointF([float]$x, [float]($y - 2 + $len))),
                    (New-Object System.Drawing.PointF([float]($x + 6), [float]($y - 2)))
                ))
                $g.FillPath($iceBrush, $path)
                $g.DrawPath($icePen, $path)
                $path.Dispose()
            }
        }
        if ($inside) { $runHeight++ }
    }
}

function Draw-Snowflake([double]$cx, [double]$cy, [double]$radius) {
    $shadowPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(190, 113, 183, 225), [float]($radius * 0.16))
    $whitePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 249, 253, 255), [float]([Math]::Max(1.1, $radius * 0.085)))
    for ($arm = 0; $arm -lt 6; $arm++) {
        $angle = ($arm * [Math]::PI / 3.0) - ([Math]::PI / 2.0)
        $ex = $cx + ([Math]::Cos($angle) * $radius)
        $ey = $cy + ([Math]::Sin($angle) * $radius)
        $g.DrawLine($shadowPen, [float]$cx, [float]$cy, [float]$ex, [float]$ey)
        $g.DrawLine($whitePen, [float]$cx, [float]$cy, [float]$ex, [float]$ey)
        for ($branch = 0; $branch -lt 2; $branch++) {
            $fraction = 0.52 + (0.16 * $branch)
            $bx = $cx + ([Math]::Cos($angle) * $radius * $fraction)
            $by = $cy + ([Math]::Sin($angle) * $radius * $fraction)
            $side = if ($branch -eq 0) { 1.0 } else { -1.0 }
            $branchAngle = $angle + ($side * 0.56)
            $tx = $bx + ([Math]::Cos($branchAngle) * $radius * 0.35)
            $ty = $by + ([Math]::Sin($branchAngle) * $radius * 0.35)
            $g.DrawLine($shadowPen, [float]$bx, [float]$by, [float]$tx, [float]$ty)
            $g.DrawLine($whitePen, [float]$bx, [float]$by, [float]$tx, [float]$ty)
        }
    }
    $dot = [Math]::Max(1.5, $radius * 0.12)
    $g.FillEllipse($snowBrush, [float]($cx - $dot), [float]($cy - $dot), [float]($dot * 2), [float]($dot * 2))
    $shadowPen.Dispose()
    $whitePen.Dispose()
}

$flakes = @(
    @(255, 165, 22), @(595, 185, 18), @(875, 105, 13),
    @(1125, 150, 24), @(1370, 245, 17),
    @(285, 585, 15), @(475, 645, 11), @(830, 615, 20),
    @(1100, 655, 14), @(1370, 560, 18),
    @(135, 390, 9), @(1515, 390, 10)
)
foreach ($flake in $flakes) {
    Draw-Snowflake ([double]$flake[0]) ([double]$flake[1]) ([double]$flake[2])
}

$dots = @(
    @(180, 110, 3), @(735, 90, 2), @(930, 215, 2), @(1220, 85, 3),
    @(1470, 300, 2), @(210, 500, 2), @(680, 550, 3), @(1020, 520, 2),
    @(1480, 680, 3), @(350, 780, 2), @(700, 825, 2), @(1270, 790, 2)
)
foreach ($dot in $dots) {
    $g.FillEllipse($snowBrush, [float]($dot[0] - $dot[2]), [float]($dot[1] - $dot[2]), [float]($dot[2] * 2), [float]($dot[2] * 2))
}

$g.Dispose()
$out.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$previewW = 1000
$previewH = [int]($h * $previewW / $w)
$preview = New-Object System.Drawing.Bitmap($previewW, $previewH, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$pg = [System.Drawing.Graphics]::FromImage($preview)
$pg.Clear([System.Drawing.Color]::FromArgb(255, 239, 157, 70))
$pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$pg.DrawImage($out, 0, 0, $previewW, $previewH)
$pg.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encoder = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encoder.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 86L)
$preview.Save($PreviewPath, $codec, $encoder)
$preview.Dispose()
$out.Dispose()
$src.Dispose()

Write-Output "titre hiver ecrit : $OutputPath"
Write-Output "apercu ecrit : $PreviewPath"
