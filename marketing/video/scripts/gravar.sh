#!/usr/bin/env bash
# Grava uma cena do app (MacleanFy) com o roteiro de cenas/<cena>.mjs, fora da tela
# e com os dados de demonstração. Rodar `corepack pnpm build` no app antes.
# Uso: bash scripts/gravar.sh <cena> <rota> <idioma: pt|en>
set -euo pipefail
cena="${1:?cena}"; rota="${2:?rota}"; lang="${3:?idioma}"
aqui="$(cd "$(dirname "$0")/.." && pwd)"
app="$(cd "$aqui/../.." && pwd)"
saida="$aqui/public/brutos/mac/$lang"
mkdir -p "$saida"
case "$lang" in en) locale=en-US ;; *) locale=pt-BR ;; esac
cd "$app"
MACLEANFY_RECORD="$saida/$cena.mp4" MACLEANFY_RECORD_SCRIPT="$aqui/cenas/$cena.mjs" \
  MACLEANFY_ROUTE="$rota" MACLEANFY_LOCALE="$locale" corepack pnpm start 2>&1 \
  | grep -i -e error -e 'não achei' -e 'esperei' -e failed || true
test -s "$saida/$cena.mp4"
echo "$saida/$cena.mp4 $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$saida/$cena.mp4")s"
