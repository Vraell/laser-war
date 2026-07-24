#!/usr/bin/env bash
set -euo pipefail

python3.11 -m pip install -e ".[release]"
python3.11 -m PyInstaller --clean --noconfirm LaserWar.spec
