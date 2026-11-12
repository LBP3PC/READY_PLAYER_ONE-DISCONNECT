Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\zanin\.freebuff\worktrees\52e34c03\b058eb64db5735d243b769e61850887dde545b8e75766809'
$out  = Join-Path $root 'launcher-app'
$ttf  = Join-Path $root 'hosting\public\futura-extra-bold.ttf'

$pfc = New-Object System.Drawing.Text.PrivateFontCollection
if (Test-Path $ttf) { $pfc.AddFontFile($ttf); $family = $pfc.Families[0]; "police: " + $family.Name }
else { $family = New-Object System.Drawing.FontFamily('Arial Black'); "police de repli: Arial Black" }

$fill  = [System.Drawing.Color]::FromArgb(255, 6, 50, 201)
$cyan  = [System.Drawing.Color]::FromArgb(255, 119, 234, 255)
$deep  = [System.Drawing.Color]::FromArgb(255, 8, 38, 127)
$white = [System.Drawing.Color]::White

function Text-Path([string]$text, [double]$size, [double]$tracking) {
  $all = New-Object System.Drawing.Drawing2D.GraphicsPath
  $x = 0.0
  $fmt = [System.Drawing.StringFormat]::GenericTypographic
  foreach ($ch in $text.ToCharArray()) {
    $sub = New-Object System.Drawing.Drawing2D.GraphicsPath
    $sub.AddString([string]$ch, $family, [int][System.Drawing.FontStyle]::Bold, [single]$size, (New-Object System.Drawing.PointF(0, 0)), $fmt)
    $b = $sub.GetBounds()
    $m = New-Object System.Drawing.Drawing2D.Matrix
    $m.Translate([single]($x - $b.X), [single](-$b.Y), [System.Drawing.Drawing2D.MatrixOrder]::Append)
    $sub.Transform($m)
    $all.AddPath($sub, $false)
    $x += $b.Width - ($size * $tracking)
    $sub.Dispose()
  }
  return $all
}

function Fit([System.Drawing.Drawing2D.GraphicsPath]$path, [double]$x, [double]$y, [double]$w, [double]$h) {
  $b = $path.GetBounds()
  if ($b.Width -le 0 -or $b.Height -le 0) { return }
  $s = [Math]::Min($w / $b.Width, $h / $b.Height)
  $nx = $x + ($w - $b.Width * $s) / 2
  $ny = $y + ($h - $b.Height * $s) / 2
  $m = New-Object System.Drawing.Drawing2D.Matrix
  $m.Translate(-$b.X, -$b.Y, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $m.Scale([single]$s, [single]$s, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $m.Translate([single]$nx, [single]$ny, [System.Drawing.Drawing2D.MatrixOrder]::Append)
  $path.Transform($m)
}

function RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc([single]$x, [single]$y, [single]$d, [single]$d, 180, 90)
  $p.AddArc([single]($x + $w - $d), [single]$y, [single]$d, [single]$d, 270, 90)
  $p.AddArc([single]($x + $w - $d), [single]($y + $h - $d), [single]$d, [single]$d, 0, 90)
  $p.AddArc([single]$x, [single]($y + $h - $d), [single]$d, [single]$d, 90, 90)
  $p.CloseFigure()
  return $p
}

function Mark-Paths([double]$x, [double]$y, [double]$s) {
  $frame = RoundedPath ($x + $s * 0.05) ($y + $s * 0.05) ($s * 0.90) ($s * 0.90) ($s * 0.17)
  $eyes = New-Object System.Drawing.Drawing2D.GraphicsPath
  $eyes.AddRectangle((New-Object System.Drawing.RectangleF([single]($x + $s * 0.33), [single]($y + $s * 0.30), [single]($s * 0.11), [single]($s * 0.24))))
  $eyes.AddRectangle((New-Object System.Drawing.RectangleF([single]($x + $s * 0.56), [single]($y + $s * 0.30), [single]($s * 0.11), [single]($s * 0.24))))
  $smile = New-Object System.Drawing.Drawing2D.GraphicsPath
  $smile.AddBezier([single]($x + $s * 0.24), [single]($y + $s * 0.60), [single]($x + $s * 0.36), [single]($y + $s * 0.82), [single]($x + $s * 0.64), [single]($y + $s * 0.82), [single]($x + $s * 0.76), [single]($y + $s * 0.60))
  return @{ frame = $frame; eyes = $eyes; smile = $smile }
}

function Save-Title([string]$file, [bool]$shadowOnly) {
  $bmp = New-Object System.Drawing.Bitmap(1024, 1024)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $rec  = Text-Path 'REC' 400 0.045
  $blue = Text-Path 'BLUE' 400 0.045
  Fit $rec  36 286 520 245
  Fit $blue 36 588 952 272
  $mark = Mark-Paths 586 240 330

  $solid = New-Object System.Drawing.Drawing2D.GraphicsPath
  $solid.AddPath($rec, $false)
  $solid.AddPath($blue, $false)
  $solid.AddPath($mark.frame, $false)
  $solid.AddPath($mark.eyes, $false)

  if ($shadowOnly) {
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 5, 14, 70))
    $g.FillPath($brush, $solid)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 5, 14, 70), [single](330 * 0.075))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawPath($pen, $mark.smile)
    $pen.Dispose()
    $brush.Dispose()
  }
  else {
    # decalages de la marque du site : cyan (#77EAFF) puis bleu profond (#08267F)
    foreach ($shadow in @(@{ dy = 6; color = $cyan }, @{ dy = 13; color = $deep })) {
      $brush = New-Object System.Drawing.SolidBrush($shadow.color)
      $matrix = New-Object System.Drawing.Drawing2D.Matrix
      $matrix.Translate(0, $shadow.dy, [System.Drawing.Drawing2D.MatrixOrder]::Append)
      $copy = $solid.Clone()
      $copy.Transform($matrix)
      $g.FillPath($brush, $copy)
      $copy.Dispose(); $matrix.Dispose(); $brush.Dispose()
    }

    # Contour blanc : un trait GDI+ est centre sur le trace, on le dessine donc deux
    # fois plus epais pour que la moitie exterieure reste visible apres le remplissage.
    $stroke = New-Object System.Drawing.Pen($white, [single]40)
    $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($stroke, $rec)
    $g.DrawPath($stroke, $blue)
    $g.DrawPath($stroke, $mark.frame)
    $g.DrawPath($stroke, $mark.eyes)
    $stroke.Dispose()

    # sourire : trait blanc large sous le trait cyan
    $smileWhite = New-Object System.Drawing.Pen($white, [single](330 * 0.075 + 40))
    $smileWhite.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $smileWhite.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawPath($smileWhite, $mark.smile)
    $smileWhite.Dispose()

    $fillBrush = New-Object System.Drawing.SolidBrush($fill)
    $g.FillPath($fillBrush, $rec)
    $g.FillPath($fillBrush, $blue)
    $fillBrush.Dispose()

    # la marque : plaque blanche, bordure bleue, yeux bleus, sourire cyan
    $whiteBrush = New-Object System.Drawing.SolidBrush($white)
    $g.FillPath($whiteBrush, $mark.frame)
    $whiteBrush.Dispose()

    $framePen = New-Object System.Drawing.Pen($fill, [single](330 * 0.070))
    $framePen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($framePen, $mark.frame)
    $framePen.Dispose()

    $eyeBrush = New-Object System.Drawing.SolidBrush($fill)
    $g.FillPath($eyeBrush, $mark.eyes)
    $eyeBrush.Dispose()

    $smilePen = New-Object System.Drawing.Pen($cyan, [single](330 * 0.075))
    $smilePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $smilePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawPath($smilePen, $mark.smile)
    $smilePen.Dispose()
  }

  $g.Dispose()
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output ('ecrit: ' + $file)
}

Save-Title (Join-Path $out 'RecBlueTitle.png') $false
Save-Title (Join-Path $out 'RecBlueTitle-512.png') $false
Save-Title (Join-Path $out 'RecBlueTitleShadow.png') $true

# petite version 512 pour l'exemple : on la produit en reduisant la 1024
$src = [System.Drawing.Image]::FromFile((Join-Path $out 'RecBlueTitle.png'))
$thumb = New-Object System.Drawing.Bitmap(512, 512)
$tg = [System.Drawing.Graphics]::FromImage($thumb)
$tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$tg.DrawImage($src, 0, 0, 512, 512)
$tg.Dispose()
$thumb.Save((Join-Path $out 'RecBlueTitle-512.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$thumb.Dispose(); $src.Dispose()
Write-Output 'ecrit: RecBlueTitle-512.png'
