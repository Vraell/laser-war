from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files


project_root = Path.cwd()
icon_path = project_root / "laser_war" / "assets" / "app-icon.png"

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
    upx=True,
    console=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(icon_path),
)

collection = COLLECT(
    executable,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=True,
    name="Laser War",
)

application = BUNDLE(
    collection,
    name="Laser War.app",
    icon=str(icon_path),
    bundle_identifier="com.laserwar.game",
    info_plist={
        "CFBundleDisplayName": "Laser War",
        "CFBundleShortVersionString": "0.2.0",
        "NSHighResolutionCapable": True,
    },
)
