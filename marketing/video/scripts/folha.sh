#!/usr/bin/env bash
# Folha de contato de um vídeo: um quadro a cada <intervalo> segundos, em grade,
# para escolher os cortes de uma gravação ou revisar um render olhando uma imagem.
# O ffmpeg do Homebrew vem sem drawtext, então não há carimbo de tempo: conte
# as células (a célula n é o segundo n × intervalo).
# Uso: bash scripts/folha.sh <video> [intervalo=1] [colunas=10] [saida=<video>.folha.png]
set -euo pipefail
video="${1:?video}"
intervalo="${2:-1}"
colunas="${3:-10}"
saida="${4:-${video%.*}.folha.png}"
tamanho=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$video")
# O ffprobe 8 termina a linha com o separador ("1080x1920x"): sem tirar o x do fim,
# a altura vira "1920x" e o teste do retrato falha.
tamanho=${tamanho%x}
largura=${tamanho%x*}
altura=${tamanho#*x}
duracao=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$video")
celulas=$(awk -v d="$duracao" -v i="$intervalo" 'BEGIN { n = int(d / i) + 1; print n }')
linhas=$(( (celulas + colunas - 1) / colunas ))
# Retrato: células estreitas; paisagem: mais largas.
if [ "$altura" -gt "$largura" ]; then escala=150; else escala=320; fi
ffmpeg -v error -y -i "$video" -vf "fps=1/$intervalo,scale=$escala:-1,tile=${colunas}x${linhas}" -frames:v 1 "$saida"
echo "$saida  ($celulas quadros, ${colunas}x${linhas}, 1 a cada ${intervalo}s)"
