#!/bin/bash
# ─────────────────────────────────────────────
# AsistApp — Instalador de icono en el escritorio
# ─────────────────────────────────────────────

APP_DIR="$HOME/Documentos/Asistencia/Asistencia"
DESKTOP_FILE="$APP_DIR/AsistApp.desktop"
LAUNCH_FILE="$APP_DIR/launch.sh"

# Dar permisos de ejecución
chmod +x "$LAUNCH_FILE"
chmod +x "$DESKTOP_FILE"

# Detectar carpeta del escritorio
if [ -d "$HOME/Escritorio" ]; then
  DEST="$HOME/Escritorio"
elif [ -d "$HOME/Desktop" ]; then
  DEST="$HOME/Desktop"
else
  mkdir -p "$HOME/Desktop"
  DEST="$HOME/Desktop"
fi

# Copiar el acceso directo
cp "$DESKTOP_FILE" "$DEST/AsistApp.desktop"
chmod +x "$DEST/AsistApp.desktop"

# Marcar como confiable (GNOME)
gio set "$DEST/AsistApp.desktop" metadata::trusted true 2>/dev/null

echo "✓ Icono instalado en: $DEST"
echo "  Haz doble clic en AsistApp para abrir la app en tu navegador."
echo ""
echo "  La app se sirve en: http://localhost:8765"
echo "  El servidor se inicia automáticamente al hacer clic."
