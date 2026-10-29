#!/usr/bin/env bash
# O Chrome do Remotion sem processo de GPU: com o Mac bloqueado (ou a tela
# apagada) o processo de GPU do chrome-headless-shell cai e leva o render junto.
# Usado com --browser-executable=scripts/chrome.sh.
aqui="$(cd "$(dirname "$0")/.." && pwd)"
exec "$aqui/node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  --in-process-gpu --disable-gpu-sandbox "$@"
