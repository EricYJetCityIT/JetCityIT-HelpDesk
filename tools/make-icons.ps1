# Regenerates icons/*.png (the home-screen icons for the staff and client apps) from logo.png.
# Run from anywhere:  powershell -File tools\make-icons.ps1
# The source logo is small (237 px) hairline line art, so the strokes are thickened slightly and the
# art sits on a solid brand-navy square (iPhone paints transparent icons black). If a larger or
# redrawn logo is ever supplied, replace logo.png and re-run this.
Add-Type -AssemblyName System.Drawing

$repo = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repo 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$src = [System.Drawing.Bitmap]::FromFile((Join-Path $repo 'logo.png'))

# Bounding box of the visible (non-transparent) part, so the circle is centred and the
# transparent margin of the source file doesn't shrink it.
$minX = $src.Width; $minY = $src.Height; $maxX = 0; $maxY = 0
for ($y = 0; $y -lt $src.Height; $y++) {
  for ($x = 0; $x -lt $src.Width; $x++) {
    if ($src.GetPixel($x, $y).A -gt 16) {
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
$bw = $maxX - $minX + 1; $bh = $maxY - $minY + 1
Write-Host "visible logo box: x $minX-$maxX, y $minY-$maxY ($bw x $bh)"

# Brand navy, sampled from the logo itself (#052A3F): the icon background must be OPAQUE because
# iOS paints transparent icons black.
$navy = [System.Drawing.Color]::FromArgb(255, 5, 42, 63)

$thicken = 0.0032

function New-Icon([int]$size, [double]$fill, [string]$name) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear($navy)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $target = $size * $fill
  $scale = [Math]::Min($target / $bw, $target / $bh)
  $dw = $bw * $scale; $dh = $bh * $scale
  $dx = ($size - $dw) / 2; $dy = ($size - $dh) / 2
  $srcRect = New-Object System.Drawing.RectangleF([single]$minX, [single]$minY, [single]$bw, [single]$bh)
  # The logo is hairline line art, which turns faint at home-screen size. Drawing it several times a
  # fraction of a pixel apart thickens every stroke a little without changing the shape.
  $o = $size * $thicken
  foreach ($ox in @(-$o, 0, $o)) {
    foreach ($oy in @(-$o, 0, $o)) {
      $destRect = New-Object System.Drawing.RectangleF([single]($dx + $ox), [single]($dy + $oy), [single]$dw, [single]$dh)
      $g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    }
  }
  $g.Dispose()
  $path = Join-Path $outDir $name
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("wrote {0} ({1} px, {2} bytes)" -f $name, $size, (Get-Item $path).Length)
}

# "any" icons fill most of the square; the maskable one keeps the art inside the central 80% safe zone
# (Android may crop it to a circle/squircle).
New-Icon 180 0.82 'icon-180.png'
New-Icon 192 0.82 'icon-192.png'
New-Icon 512 0.82 'icon-512.png'
New-Icon 512 0.60 'icon-maskable-512.png'
$src.Dispose()
