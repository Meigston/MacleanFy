#!/usr/bin/env bash
# Confere um render: formato, duração, folha de um quadro a cada 2,5 s (abrir a
# imagem e olhar cena por cena) e o volume integrado, que deve sair parecido
# entre os idiomas.
# Uso: bash scripts/conferir.sh saida/<formato>-<idioma>.mp4
set -euo pipefail
video="${1:?video}"
aqui="$(cd "$(dirname "$0")" && pwd)"
ffprobe -v error -show_entries format=duration:stream=codec_name,width,height,r_frame_rate -of compact "$video"
bash "$aqui/folha.sh" "$video" 2.5 6
ffmpeg -hide_banner -i "$video" -af ebur128=framelog=quiet -f null - 2>&1 | grep -A1 'Integrated loudness' | tail -1
