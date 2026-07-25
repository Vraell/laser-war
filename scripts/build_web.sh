#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="$project_root/build/web"

rm -rf "$staging"
mkdir -p "$staging/assets"
cp "$project_root/web/index.html" "$staging/index.html"
cp "$project_root/web/styles.css" "$staging/styles.css"
cp "$project_root"/web/*.js "$staging/"
cp "$project_root/web/assets/menu-background.webp" "$staging/assets/menu-background.webp"
cp "$project_root/web/assets/app-icon.png" "$staging/assets/app-icon.png"
cp "$project_root/laser_war/assets/fonts/InterVariable.ttf" "$staging/assets/InterVariable.ttf"
cp "$project_root/laser_war/assets/fonts/Inter-LICENSE.txt" "$staging/assets/Inter-LICENSE.txt"

printf 'Built native web game at %s\n' "$staging"
