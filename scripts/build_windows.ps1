$ErrorActionPreference = "Stop"

python -m pip install -e ".[release]"
python -m unittest discover -v
python -m PyInstaller --clean --noconfirm LaserWarWindows.spec

New-Item -ItemType Directory -Force -Path "release" | Out-Null
$archive = "release\Laser-War-Portable-Windows-x64.zip"
if (Test-Path $archive) {
    Remove-Item $archive
}
Compress-Archive -Path "dist\Laser War\*" -DestinationPath $archive -CompressionLevel Optimal

$compiler = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $compiler)) {
    throw "Inno Setup 6 was not found at $compiler"
}
& $compiler "installer\LaserWar.iss"
