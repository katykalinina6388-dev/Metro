#!/usr/bin/env bash
# Сборка архива с игрой для Windows: dist/Dispetcher-metro-NVL.zip
# Нужны: Go 1.22+, zip. Файлы игры (включая модель распознавания и озвучку) уже лежат в game/.
set -euo pipefail
cd "$(dirname "$0")/.."
GO="${GO:-go}"
OUT=dist
EXE="Диспетчер метро.exe"
rm -rf "$OUT" && mkdir -p "$OUT/pkg"
for f in game/index.html game/data/geo.js game/vendor/vosk.js game/vosk/model-ru.tar.gz game/voices/index.json; do
  [ -f "$f" ] || { echo "нет файла $f" >&2; exit 1; }
done
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 "$GO" build -trimpath -ldflags "-s -w -H=windowsgui" -o "$OUT/pkg/$EXE" .
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 "$GO" build -trimpath -ldflags "-s -w" -o "$OUT/metro-dispatcher-linux" .
cp "docs/ПРОЧТИ.txt" "$OUT/pkg/ПРОЧТИ.txt"
cp THIRD-PARTY.md "$OUT/pkg/ЛИЦЕНЗИИ.txt"
python3 tools/mkzip.py "$OUT/pkg" "$OUT/Dispetcher-metro-NVL.zip"
