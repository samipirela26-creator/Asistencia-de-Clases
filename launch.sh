#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  AsistApp — Lanzador de escritorio
#  Levanta un servidor local y abre la app en el navegador
# ─────────────────────────────────────────────────────────────────

APP_DIR="$HOME/Documentos/Asistencia/Asistencia"
PORT=8765
URL="http://localhost:$PORT"

# Si ya hay un servidor corriendo en ese puerto, solo abrir el navegador
if lsof -ti :$PORT &>/dev/null; then
  echo "Servidor ya activo en $URL"
else
  # Iniciar servidor HTTP en segundo plano
  cd "$APP_DIR"
  python3 -m http.server $PORT --bind 127.0.0.1 &>/tmp/asistapp-server.log &
  SERVER_PID=$!
  echo "Servidor iniciado (PID $SERVER_PID) en $URL"
  sleep 0.6   # Dar tiempo a que arranque
fi

# Abrir en el navegador por defecto
xdg-open "$URL" 2>/dev/null || \
  google-chrome "$URL" 2>/dev/null || \
  firefox "$URL" 2>/dev/null || \
  chromium-browser "$URL" 2>/dev/null

exit 0
