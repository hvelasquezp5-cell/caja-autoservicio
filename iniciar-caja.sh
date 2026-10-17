#!/usr/bin/env bash
# Arranca la caja en la Pi 400 en segundo plano: sigue corriendo aunque se cierre la terminal.
# Registro: ~/caja.log. Para detenerla: pkill -f caja-autoservicio/caja/app.py
cd "$(dirname "$0")/caja"
pkill -f "caja/app.py|python app.py" && sleep 1
nohup ~/caja-env/bin/python "$PWD/app.py" > ~/caja.log 2>&1 < /dev/null &
sleep 3
echo "Caja corriendo en http://$(hostname -I | cut -d' ' -f1):8000 (registro en ~/caja.log)"
