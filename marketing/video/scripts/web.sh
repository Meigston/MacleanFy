#!/usr/bin/env bash
# Leva os vídeos renderizados para a pasta do site: o mp4 para a web (H.264 com
# o índice no começo, para tocar antes de baixar inteiro), o pôster e a legenda.
# Uso: bash scripts/web.sh <horizontal|vertical> <destino> [prefixo=video] [segundo do pôster=13]
#   saem <destino>/<prefixo>-<idioma>.mp4, poster-<idioma>.jpg e legendas-<idioma>.vtt
#   CRF=26 deixa o mp4 abaixo dos 10 MB que o GitHub aceita como anexo.
set -euo pipefail
raiz="$(cd "$(dirname "$0")/.." && pwd)"
formato="${1:?horizontal ou vertical}"
destino="${2:?pasta de destino}"
prefixo="${3:-video}"
segundo="${4:-13}"
mkdir -p "$destino"
cd "$raiz"

node scripts/manifesto.mjs >/dev/null
node scripts/legendas.mjs "$formato" "$destino"

for lang in $(node -e "const r=require('./roteiro.json');console.log(Object.keys((r['$formato']||{}).falas||{}).join(' '))"); do
  origem="saida/$formato-$lang.mp4"
  ffmpeg -v error -y -i "$origem" \
    -c:v libx264 -preset slow -crf "${CRF:-24}" -pix_fmt yuv420p -profile:v high \
    -c:a aac -b:a 128k -movflags +faststart \
    "$destino/$prefixo-$lang.mp4"
  # O pôster é uma cena com o produto na tela, e não a abertura escura.
  ffmpeg -v error -y -ss "$segundo" -i "$origem" -frames:v 1 -q:v 4 "$destino/poster-$lang.jpg"
  printf '%s  %s  %s\n' "$lang" "$(du -h "$destino/$prefixo-$lang.mp4" | cut -f1)" "$(du -h "$destino/poster-$lang.jpg" | cut -f1)"
done
