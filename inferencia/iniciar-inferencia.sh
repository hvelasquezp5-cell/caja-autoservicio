#!/usr/bin/env bash
# Arranca el servicio de inferencia en segundo plano (VM Debian o Pi). Registro: ~/inferencia.log
# Uso: bash iniciar-inferencia.sh [ruta del modelo] [tamaño de imagen]
# Para detenerlo: pkill -f "uvicorn servicio:app"
MODELO="${1:-$HOME/modelos/unificado_v4.pt}"
IMGSZ="${2:-640}"
cd "$(dirname "$0")"
. ~/yolo-env/bin/activate
pip install -q fastapi uvicorn

pkill -f "uvicorn servicio:app" && sleep 1
MODELO="$MODELO" IMGSZ="$IMGSZ" NODE_NAME="$(hostname)" \
  nohup uvicorn servicio:app --host 0.0.0.0 --port 8001 > ~/inferencia.log 2>&1 < /dev/null &

echo "Cargando $MODELO ..."
for _ in $(seq 45); do
  sleep 2
  if python -c "import urllib.request as u; print(u.urlopen('http://localhost:8001/salud').read().decode())" 2>/dev/null; then
    echo "Servicio de inferencia listo en http://$(hostname -I | cut -d' ' -f1):8001"
    exit 0
  fi
done
echo "No arrancó. Últimas líneas de ~/inferencia.log:"
tail -20 ~/inferencia.log
exit 1
