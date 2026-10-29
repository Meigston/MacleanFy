#!/usr/bin/env bash
# Renderiza um formato nos idiomas dele (todos os de roteiro.json, ou os pedidos)
# em saida/<formato>-<idioma>.mp4.
# Uso: bash scripts/render.sh <horizontal|vertical> [idioma ...]
set -euo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
formato="${1:?horizontal ou vertical}"
shift
cd "$raiz"
node scripts/manifesto.mjs >/dev/null
if [ $# -eq 0 ]; then
  set -- $(node -e "const r=require('./roteiro.json');console.log(Object.keys((r['$formato']||{}).falas||{}).join(' '))")
fi
# O vertical vai para plataformas que reencodam por cima: sai com mais qualidade.
crf=20
[ "$formato" != horizontal ] && crf=18
mkdir -p saida
for lang in "$@"; do
  # scripts/chrome.sh: o Chrome do Remotion sem processo de GPU, que cai com o Mac bloqueado.
  npx remotion render src/index.ts "$formato-$lang" "saida/$formato-$lang.mp4" --codec=h264 --crf=$crf --log=error \
    --browser-executable="$raiz/scripts/chrome.sh"
  printf '%s  %ss\n' "saida/$formato-$lang.mp4" "$(ffprobe -v error -show_entries format=duration -of csv=p=0 "saida/$formato-$lang.mp4")"
done
