#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="$project_root/build/web"

rm -rf "$staging"
mkdir -p "$staging/assets"
mkdir -p "$staging/docs"
cp "$project_root/web/index.html" "$staging/index.html"
cp "$project_root/web/styles.css" "$staging/styles.css"
cp "$project_root"/web/*.js "$staging/"
cp "$project_root/web/assets/menu-background.jpg" "$staging/assets/menu-background.jpg"
cp "$project_root/web/assets/app-icon.png" "$staging/assets/app-icon.png"
cp "$project_root/web/assets/InterVariable.ttf" "$staging/assets/InterVariable.ttf"
cp "$project_root/web/assets/Inter-LICENSE.txt" "$staging/assets/Inter-LICENSE.txt"
cp "$project_root/web/assets/lucide-LICENSE.txt" "$staging/assets/lucide-LICENSE.txt"
cp "$project_root/web/assets/logic-solver-LICENSE.txt" "$staging/assets/logic-solver-LICENSE.txt"
cp "$project_root/docs/ULTRA_EVALUATION.pdf" "$staging/docs/ULTRA_EVALUATION.pdf"

printf 'Built web game at %s\n' "$staging"
