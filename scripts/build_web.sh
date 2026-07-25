#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging="$project_root/build/web"

rm -rf "$staging"
mkdir -p "$staging/assets"
cp "$project_root/web/index.html" "$staging/index.html"
cp "$project_root/web/styles.css" "$staging/styles.css"
cp "$project_root/web/app.js" "$staging/app.js"
cp "$project_root/web/save.js" "$staging/save.js"
cp "$project_root/web/progress.js" "$staging/progress.js"
cp "$project_root/web/i18n.js" "$staging/i18n.js"
cp "$project_root/web/beam.js" "$staging/beam.js"
cp "$project_root/web/engine.js" "$staging/engine.js"
cp "$project_root/web/ai.js" "$staging/ai.js"
cp "$project_root/web/ai_worker.js" "$staging/ai_worker.js"
cp "$project_root/web/assets/menu-background.webp" "$staging/assets/menu-background.webp"
cp "$project_root/web/assets/app-icon.png" "$staging/assets/app-icon.png"
cp "$project_root/laser_war/assets/fonts/InterVariable.ttf" "$staging/assets/InterVariable.ttf"

printf 'Built native web game at %s\n' "$staging"
