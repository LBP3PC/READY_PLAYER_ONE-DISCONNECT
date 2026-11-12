Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$root = 'C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809'
$out  = Join-Path $root 'launcher-app'

$blue      = [System.Drawing.Color]::FromArgb(255, 26, 45, 214)
$blueDeep  = [System.Drawing.Color]::FromArgb(255, 14, 32, 168)
$cyan      = [System.Drawing.Color]::FromArgb(255, 60, 214, 255)
$white     = [System.Drawing.Color]::White

function New-FittedPath([string]$text, [double]$x, [double]$y, [double]$w, [double]$h, [string]$family, [double]$em) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $fmt  = New-Object System.Drawing.StringFormat
  $fmt.FormatFlags = [System.Drawing.StringFormatFlags]::NoClip
  $path.AddString($text, (New-Object System.Drawing.FontFamily($family)), [int][System.Drawing.FontStyle]::Bold, [single]$em, (New-Object System.Drawing.PointF(0, 0)), $fmt)
  $b = $path.GetBounds()
  if ($b.Width -le 0 -or $b.Height -le 0) { return $path }
  $s = [Math]::Min($w / $b.Width, $h / $b.Height)
  $nx = $x + ($w - $b.Width * $s) / 2
  $ny = $y + ($h - $b.Height * $s) / 2
  $m = New-Object System.Drawing.Drawing2D.Matrix
  $m.Translate(-$b.X, -$b.Y, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $m.Scale([single]$s, [single]$s, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $m.Translate([single]$nx, [single]$ny, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $path.Transform($m)
  $fmt.Dispose()
  return $path
}

function Add-RoundedRect($path, [double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $d = $r * 2
  $path.AddArc([single]$x, [single]$y, [single]$d, [single]$d, 180, 90)
  $path.AddArc([single]($x + $w - $d), [single]$y, [single]$d, [single]$d, 270, 90)
  $path.AddArc([single]($x + $w - $d), [single]($y + $h - $d), [single]$d, [single]$d, 0, 90)
  $path.AddArc([single]$x, [single]($y + $h - $d), [single]$d, [single]$d, 90, 90)
  $path.CloseFigure()
}

function New-MarkPath([double]$x, [double]$y, [double]$size) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $t = $size * 0.11
  $r = $size * 0.16
  # cadre arrondi
  Add-RoundedRect $p ($x + $t) ($y + $t) ($size - 2 * $t) ($size - 2 * $t) $r
  $inner = $size - 4 * $t
  # yeux (deux traits verticaux)
  $eyeTop = $y + $size * 0.34
  $eyeH = $size * 0.20
  $eyeW = $size * 0.085
  $p.AddRectangle((New-Object System.Drawing.RectangleF([single]($x + $size * 0.36), [single]$eyeTop, [single]$eyeW, [single]$eyeH)))
  $p.AddRectangle((New-Object System.Drawing.RectangleF([single]($x + $size * 0.57), [single]$eyeTop, [single]$eyeW, [single]$eyeH)))
  # sourire
  $smile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $smile.AddBezier([single]($x + $size * 0.28), [single]($y + $size * 0.60), [single]($x + $size * 0.40), [single]($y + $size * 0.80), [single]($x + $size * 0.62), [single]($y + $size * 0.80), [single]($x + $size * 0.74), [single]($y + $size * 0.60))
  $penW = $size * 0.085
  $cap = New-Object System.Drawing.Pen([System.Drawing.Color]::Black, [single]$penW)
  $cap.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $cap.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $smilePath = $smile.Clone()
  $smilePath.Widen($cap)
  $p.AddPath($smilePath, $false)
  $cap.Dispose()
  return $p
}

function Save-Title([string]$file, [int]$w, [int]$h, [double]$scale) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Geometrie calquee sur le logo d'origine (1024x1024, deux lignes).
  $line1 = @{ x = 40 * $scale; y = 300 * $scale; w = 600 * $scale; h = 300 * $scale }
  $mark  = @{ x = 620 * $scale; y = 292 * $scale; s = 300 * $scale }
  $line2 = @{ x = 70 * $scale; y = 585 * $scale; w = 880 * $scale; h = 310 * $scale }

  $family = 'Arial Black'
  $p1 = New-FittedPath 'REC' $line1.x $line1.y $line1.w $line1.h $family (300 * $scale)
  $p2 = New-FittedPath 'BLUE' $line2.x $line2.y $line2.w $line2.h $family (330 * $scale)
  $markPath = New-MarkPath $mark.x $mark.y $mark.s

  # halo blanc diffus
  foreach ($width in @(90, 68, 50)) {
    $halo = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(38, 255, 255, 255), [single]($width * $scale))
    $halo.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($halo, $p1); $g.DrawPath($halo, $p2); $g.DrawPath($halo, $markPath)
    $halo.Dispose()
  }

  # contour blanc
  $stroke = New-Object System.Drawing.Pen($white, [single](26 * $scale))
  $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($stroke, $p1); $g.DrawPath($stroke, $p2); $g.DrawPath($stroke, $markPath)
  $stroke.Dispose()

  # remplissage : cadre de la marque en blanc, lettres et details en bleu
  $whiteBrush = New-Object System.Drawing.SolidBrush($white)
  $g.FillPath($whiteBrush, $markPath)
  $whiteBrush.Dispose()

  $blueBrush = New-Object System.Drawing.SolidBrush($blue)
  $g.FillPath($blueBrush, $p1)
  $g.FillPath($blueBrush, $p2)
  $blueBrush.Dispose()

  # la marque : trait bleu epais (re-echantillonne plus epais que le blanc)
  $markOutline = New-Object System.Drawing.Pen($blue, [single](26 * $scale))
  $markOutline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $g.DrawPath($markOutline, (New-RoundedRect-Path $mark.x $mark.y $mark.s $scale))
  $markOutline.Dispose()

  # yeux bleus + sourire cyan
  $eyeBrush = New-Object System.Drawing.SolidBrush($blue)
  $g.FillRectangle($eyeBrush, [single]($mark.x + $mark.s * 0.36), [single]($mark.y + $mark.s * 0.34), [single]($mark.s * 0.085), [single]($mark.s * 0.20))
  $g.FillRectangle($eyeBrush, [single]($mark.x + $mark.s * 0.57), [single]($mark.y + $mark.s * 0.34), [single]($mark.s * 0.085), [single]($mark.s * 0.20))
  $eyeBrush.Dispose()

  $smile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $smile.AddBezier([single]($mark.x + $mark.s * 0.28), [single]($mark.y + $mark.s * 0.60), [single]($mark.x + $mark.s * 0.40), [single]($mark.y + $mark.s * 0.80), [single]($mark.x + $mark.s * 0.62), [single]($mark.y + $mark.s * 0.80), [single]($mark.x + $mark.s * 0.74), [single]($mark.y + $mark.s * 0.60))
  $smilePen = New-Object System.Drawing.Pen($cyan, [single]($mark.s * 0.075))
  $smilePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $smilePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $g.DrawPath($smilePen, $smile)
  $smilePen.Dispose()

  $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ("ecrit: " + $file)
}

function New-RoundedRect-Path([double]$x, [double]$y, [double]$size, [double]$scale) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $t = $size * 0.11
  Add-RoundedRect $p ($x + $t) ($y + $t) ($size - 2 * $t) ($size - 2 * $t) ($size * 0.16)
  return $p
}

function Save-TitleShadow([string]$file) {
  $bmp = New-Object System.Drawing.Bitmap(1024, 1024)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $p1 = New-FittedPath 'REC' 40 300 600 300 'Arial Black' 300
  $p2 = New-FittedPath 'BLUE' 70 585 880 310 'Arial Black' 330
  $markPath = New-MarkPath 620 292 300
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 5, 14, 70))
  $g.FillPath($brush, $markPath)
  $g.FillPath($brush, $p1)
  $g.FillPath($brush, $p2)
  $brush.Dispose()
  $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ('ecrit: ' + $file)
}

Save-Title (Join-Path $out 'RecBlueTitle.png') 1024 1024 1.0
Save-Title (Join-Path $out 'RecBlueTitle-512.png') 512 512 0.5
Save-TitleShadow (Join-Path $out 'RecBlueTitleShadow.png')

# --- motif de fond (tuile) : une marque cyan sur fond transparent, tuilable ---
$tile = 256
$tb = New-Object System.Drawing.Bitmap($tile, $tile)
$tg = [System.Drawing.Graphics]::FromImage($tb)
$tg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$tg.Clear([System.Drawing.Color]::Transparent)
$markPath = (New-MarkPath 44 44 168).Clone()
$m = New-Object System.Drawing.Drawing2D.Matrix
$m.RotateAt(-24, (New-Object System.Drawing.PointF(128, 128)))
$markPath.Transform($m)
$outline = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 60, 214, 255), 7)
$outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$tg.DrawPath($outline, $markPath)
$outline.Dispose()
$tg.Dispose()
$tb.Save((Join-Path $out 'RecBluePattern.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tb.Dispose()
Write-Output 'ecrit: RecBluePattern.png'

# --- fond complet 1920x1080 : degrade bleu + grille inclinee ---
$bg = New-Object System.Drawing.Bitmap(1920, 1080)
$g2 = [System.Drawing.Graphics]::FromImage($bg)
$g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$rect = New-Object System.Drawing.Rectangle(0, 0, 1920, 1080)
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(255, 12, 60, 214), [System.Drawing.Color]::FromArgb(255, 32, 132, 255), 45)
$g2.FillRectangle($grad, $rect)
$grad.Dispose()
$g2.TranslateTransform(960, 540)
$g2.RotateTransform(-24)
$g2.TranslateTransform(-960, -540)
for ($i = -6; $i -lt 12; $i++) {
  for ($j = -6; $j -lt 12; $j++) {
    $cx = $i * 230.0
    $cy = $j * 230.0
    $mp = (New-MarkPath 0 0 150).Clone()
    $mm = New-Object System.Drawing.Drawing2D.Matrix
    $mm.Translate([single]$cx, [single]$cy, [System.Drawing.Drawing2D.MatrixOrder]::Append)
    $mp.Transform($mm)
    $gp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(120, 120, 226, 255), 6)
    $gp.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g2.DrawPath($gp, $mp)
    $gp.Dispose()
    $mp.Dispose()
  }
}
$g2.Dispose()
$bg.Save((Join-Path $out 'RecBlueBackdrop.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bg.Dispose()
Write-Output 'ecrit: RecBlueBackdrop.png'
