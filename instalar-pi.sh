#!/usr/bin/env bash
# Instala la caja en la Raspberry Pi 400. Se ejecuta una sola vez y necesita internet.
set -e
cd "$(dirname "$0")/caja"

echo "== Instalando paquetes del sistema"
sudo apt-get update
sudo apt-get install -y python3-venv python3-pip

echo "== Creando el entorno de Python en ~/caja-env"
python3 -m venv ~/caja-env
~/caja-env/bin/pip install --upgrade pip
~/caja-env/bin/pip install -r requirements.txt

echo
echo "Listo. Para arrancar la caja:"
echo "  bash ~/caja-autoservicio/iniciar-caja.sh"
