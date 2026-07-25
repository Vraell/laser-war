from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files


project_root = Path.cwd()
icon_path = project_root / "laser_war" / "assets" / "app-icon.ico"

analysis = Analysis(
    ["laser_war/launcher.py"],
    pathex=[str(project_root)],
    binaries=[],
    datas=collect_data_files("laser_war"),
    hiddenimports=["laser_war.pygame_app"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
)

archive = PYZ(analysis.pure)

executable = EXE(
    archive,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="Laser War",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    icon=str(icon_path),
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="Laser War",
)
