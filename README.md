# Caja de autoservicio con reconocimiento de productos mediante IA local en el borde

Proyecto final de Arquitectura de Computadoras II, Caso 1: inferencia de visión por computadora en tiempo real.

La cámara ve los productos, un modelo YOLO26 Nano los reconoce y la caja arma el ticket con los precios y cobra con un pago simulado. Todo funciona dentro de la red local, sin internet.

```
Cámara (iPhone con DroidCam o cámara USB)
        │
        ▼
Raspberry Pi 400 (192.168.1.60)  ── caja/app.py, puerto 8000
  página de la caja, precios.json, ventas.db
        │  envía cada imagen por la red local
        ▼
Máquina virtual Debian (192.168.1.78)  ── inferencia/servicio.py, puerto 8001
  modelo unificado_v4.pt (194 clases)
```

| Carpeta o archivo | Qué es | Dónde corre |
|---|---|---|
| `inferencia/servicio.py` | Servicio que recibe una imagen y responde las detecciones de YOLO | Máquina virtual Debian |
| `inferencia/iniciar-inferencia.sh` | Arranca el servicio del modelo en segundo plano | Máquina virtual Debian |
| `caja/` | Página web de la caja, cámara, tabla de precios y pago simulado | Raspberry Pi 400 |
| `instalar-pi.sh` | Instala las librerías de la caja (una sola vez) | Raspberry Pi 400 |
| `iniciar-caja.sh` | Arranca la caja en segundo plano | Raspberry Pi 400 |
| `k3s/`, `inferencia/Dockerfile` | Despliegue alternativo con contenedores en K3s (no se usó en la entrega) | |

## Tecnologías

- **Python** con **FastAPI** y **Uvicorn** para los dos servicios.
- **Ultralytics YOLO** para el modelo de detección.
- **OpenCV** y **httpx** para leer la cámara y enviar las imágenes al modelo.
- **SQLite** para guardar las ventas.
- **HTML, CSS y JavaScript** sin frameworks para la página de la caja.

## 1. Máquina virtual Debian (modelo)

Requisitos: el entorno `~/yolo-env` con Ultralytics y el modelo en `~/modelos/unificado_v4.pt`.

Copiar `inferencia/servicio.py` e `inferencia/iniciar-inferencia.sh` a la carpeta personal de la máquina virtual. La red de VirtualBox debe estar en **modo puente**.

Cada vez que se enciende la máquina virtual:

```bash
sudo ip addr add 192.168.1.78/24 dev enp0s3
hostname -I
bash ~/iniciar-inferencia.sh
```

`hostname -I` debe mostrar `192.168.1.78`. El script termina con `Servicio de inferencia listo`. El registro queda en `~/inferencia.log`.

Para detenerlo:

```bash
pkill -f "uvicorn servicio:app"
```

## 2. Raspberry Pi 400 (caja)

Copiar la carpeta del proyecto a `/home/grupo5/caja-autoservicio` e instalar las librerías una sola vez (necesita internet):

```bash
bash ~/caja-autoservicio/instalar-pi.sh
```

Para arrancar la caja, con el modelo ya corriendo en la máquina virtual:

```bash
curl http://192.168.1.78:8001/salud
bash ~/caja-autoservicio/iniciar-caja.sh
chromium --kiosk http://localhost:8000
```

El registro queda en `~/caja.log`. Para detenerla:

```bash
pkill -f "caja/app.py"
```

## Configuración

**`caja/config.json`**
- `camara`: `0` para una cámara USB, o la dirección de DroidCam, por ejemplo `http://192.168.1.6:4747/video`.
- `nodos`: las direcciones de los servicios de inferencia. La caja revisa cada 2 segundos cuáles responden y salta los que no.
- `ignorar`: clases que se detectan pero no se cobran ni se avisan (personas y manos).

**`caja/precios.json`**: el nombre y el precio en quetzales de cada producto. Las claves son los nombres de clase del modelo, que se pueden ver en `http://192.168.1.78:8001/clases`. No importan las mayúsculas ni los guiones. Las clases que no están en la lista no se cobran.

Si se cambia alguno de estos archivos, hay que volver a correr `iniciar-caja.sh`.

## Uso de la caja

1. Poner los productos frente a la cámara y presionar **Escanear productos** o la barra espaciadora.
2. Cada escaneo suma productos al ticket. Se pueden quitar con el botón de menos, agregar a mano o vaciar el ticket.
3. **Pagar**: en efectivo calcula el cambio; con tarjeta el pago es simulado y no pide datos de ninguna tarjeta.
4. Al final se genera un comprobante. Las ventas del día se ven en **Ventas de hoy**.

La barra inferior muestra el estado de cada nodo y qué nodo procesó el último escaneo.

## Probar sin el modelo

El servicio de inferencia tiene un modo simulado que responde detecciones al azar sin cargar YOLO:

```bash
cd inferencia
SIMULADO=1 NODE_NAME=prueba uvicorn servicio:app --port 8001
```

Y en `caja/config.json`, poner el nodo en `http://127.0.0.1:8001`.

## API

| Ruta | Qué hace |
|---|---|
| `POST /detectar` (inferencia) | Recibe un JPEG y responde `{nodo, ms, detecciones: [{clase, confianza, caja}]}` |
| `GET /salud`, `GET /clases` (inferencia) | Estado del nodo y nombres de clase del modelo |
| `POST /api/escanear` (caja) | Toma una foto, la manda al modelo y devuelve los productos con precio |
| `POST /api/ventas`, `GET /api/ventas` (caja) | Registra un pago simulado y lista las ventas del día |
| `GET /api/estado` (caja) | Estado de la cámara y de cada nodo |
