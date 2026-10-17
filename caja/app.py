"""Caja de autoservicio: cámara, ticket, pago simulado y estado del clúster.

Corre en la Pi 400 (master), que es la que tiene la cámara. Cada escaneo se envía a un
nodo de inferencia del clúster; si un nodo no responde, se reintenta en el siguiente.
"""
import base64
import json
import os
import random
import re
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Literal, Optional

import cv2
import httpx
import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE = Path(__file__).parent
CONFIG = json.loads(Path(os.getenv("CAJA_CONFIG", BASE / "config.json")).read_text(encoding="utf-8"))
PRECIOS = json.loads((BASE / "precios.json").read_text(encoding="utf-8"))
DB = BASE / "ventas.db"


def normalizar(nombre):
    """'Coca-Cola', 'coca_cola' y 'COCA COLA' cuentan como la misma clase."""
    return re.sub(r"[^a-z0-9]", "", nombre.lower())


CATALOGO = {normalizar(clase): {"clase": clase, **datos} for clase, datos in PRECIOS.items()}
IGNORAR = {normalizar(c) for c in CONFIG.get("ignorar", [])}


# ---------------------------------------------------------------- cámara

class Camara:
    """Lee la cámara en segundo plano y guarda siempre el último cuadro."""

    def __init__(self, fuente):
        self.fuente = int(fuente) if str(fuente).isdigit() else fuente
        self.cuadro = None
        self.activa = False
        self.candado = threading.Lock()
        threading.Thread(target=self._bucle, daemon=True).start()

    def _guardar(self, cuadro, activa):
        with self.candado:
            self.cuadro, self.activa = cuadro, activa

    def _bucle_mjpeg(self):
        """Lee un video MJPEG por HTTP (como el del celular con DroidCam) separando cada JPEG del flujo.

        OpenCV no siempre sabe abrir estos flujos, así que se leen a mano.
        """
        while True:
            try:
                with httpx.stream("GET", self.fuente, timeout=httpx.Timeout(5, connect=3)) as r:
                    r.raise_for_status()
                    datos = b""
                    for trozo in r.iter_bytes():
                        datos += trozo
                        inicio = datos.find(b"\xff\xd8")
                        fin = datos.find(b"\xff\xd9", inicio + 2) if inicio != -1 else -1
                        while fin != -1:
                            cuadro = cv2.imdecode(np.frombuffer(datos[inicio:fin + 2], np.uint8), cv2.IMREAD_COLOR)
                            if cuadro is not None:
                                self._guardar(cuadro, True)
                            datos = datos[fin + 2:]
                            inicio = datos.find(b"\xff\xd8")
                            fin = datos.find(b"\xff\xd9", inicio + 2) if inicio != -1 else -1
                        if len(datos) > 5_000_000:  # flujo corrupto: se descarta y se sigue leyendo
                            datos = b""
            except Exception:
                pass
            self._guardar(sin_senal(), False)
            time.sleep(2)

    def _bucle(self):
        if isinstance(self.fuente, str) and self.fuente.startswith(("http://", "https://")):
            return self._bucle_mjpeg()
        # Otra dirección (rtsp://) también es una cámara en vivo; la abre OpenCV
        es_archivo = isinstance(self.fuente, str) and "://" not in self.fuente
        if es_archivo and Path(self.fuente).suffix.lower() in (".jpg", ".jpeg", ".png"):
            imagen = cv2.imread(self.fuente)
            self._guardar(imagen if imagen is not None else sin_senal(), imagen is not None)
            return
        while True:
            captura = cv2.VideoCapture(self.fuente)
            while captura.isOpened():
                ok, cuadro = captura.read()
                if not ok:
                    break
                self._guardar(cuadro, True)
                if es_archivo:
                    time.sleep(1 / 30)  # un video se reproduce a su velocidad, no tan rápido como se pueda
            captura.release()
            if not es_archivo:
                self._guardar(sin_senal(), False)
                time.sleep(2)

    def leer(self):
        with self.candado:
            return self.cuadro, self.activa


def sin_senal():
    cuadro = np.full((480, 640, 3), (48, 42, 38), np.uint8)
    cv2.putText(cuadro, "Sin senal de camara", (150, 245), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (190, 190, 190), 2)
    return cuadro


# ---------------------------------------------------------------- clúster

def describir_error(error):
    if isinstance(error, httpx.TimeoutException):
        return "no respondió a tiempo"
    if isinstance(error, httpx.ConnectError):
        return "rechazó la conexión"
    if isinstance(error, httpx.HTTPStatusError):
        return f"respondió con error {error.response.status_code}"
    return str(error) or type(error).__name__


class Cluster:
    """Reparte los escaneos entre los nodos por turnos y salta los que no responden."""

    def __init__(self, nodos, timeout_s):
        self.nodos = [{**n, "activo": None, "latencia_ms": None, "escaneos": 0, "error": None} for n in nodos]
        self.timeout = httpx.Timeout(timeout_s, connect=1.0)
        self.turno = 0
        self.candado = threading.Lock()
        threading.Thread(target=self._vigilar, daemon=True).start()

    def _marcar(self, nodo, activo, error=None, latencia_ms=None):
        with self.candado:
            nodo["activo"], nodo["error"] = activo, error
            if latencia_ms is not None:
                nodo["latencia_ms"] = latencia_ms

    def _vigilar(self):
        """Revisa /salud de cada nodo cada 2 s para mostrar su estado en la barra del clúster."""
        with httpx.Client(timeout=httpx.Timeout(1.5, connect=1.0)) as cliente:
            while True:
                for nodo in self.nodos:
                    inicio = time.perf_counter()
                    try:
                        cliente.get(nodo["url"] + "/salud").raise_for_status()
                        self._marcar(nodo, True, latencia_ms=round((time.perf_counter() - inicio) * 1000))
                    except Exception as e:
                        self._marcar(nodo, False, describir_error(e))
                time.sleep(2)

    def _orden(self):
        """Nodos a intentar: primero los activos, empezando por el que sigue en turno."""
        with self.candado:
            inicio = self.turno % len(self.nodos)
            self.turno += 1
        rotados = self.nodos[inicio:] + self.nodos[:inicio]
        return [n for n in rotados if n["activo"] is not False] + [n for n in rotados if n["activo"] is False]

    def detectar(self, jpg):
        fallidos = []
        for nodo in self._orden():
            try:
                r = httpx.post(nodo["url"] + "/detectar", content=jpg,
                               headers={"Content-Type": "image/jpeg"}, timeout=self.timeout)
                r.raise_for_status()
                with self.candado:
                    nodo["escaneos"] += 1
                self._marcar(nodo, True)
                return r.json(), nodo["nombre"], fallidos
            except Exception as e:
                self._marcar(nodo, False, describir_error(e))
                fallidos.append({"nodo": nodo["nombre"], "error": describir_error(e)})
        raise HTTPException(503, {
            "mensaje": "Ningún nodo de inferencia respondió. Revisa los pods con: kubectl get pods -o wide",
            "fallidos": fallidos,
        })

    def estado(self):
        with self.candado:
            return [{k: n[k] for k in ("nombre", "url", "activo", "latencia_ms", "escaneos", "error")}
                    for n in self.nodos]


# ---------------------------------------------------------------- ventas

def conectar():
    conexion = sqlite3.connect(DB)
    conexion.row_factory = sqlite3.Row
    return conexion


with conectar() as c:
    c.execute("""CREATE TABLE IF NOT EXISTS ventas (
        id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT, items TEXT, total REAL,
        metodo TEXT, recibido REAL, cambio REAL, autorizacion TEXT, nodo TEXT)""")


class Linea(BaseModel):
    clase: str
    cantidad: int = Field(ge=1, le=99)


class Venta(BaseModel):
    items: list[Linea] = Field(min_length=1)
    metodo: Literal["efectivo", "tarjeta"]
    recibido: Optional[float] = None
    nodo: Optional[str] = None


def fila_a_venta(fila):
    return {**dict(fila), "items": json.loads(fila["items"])}


# ---------------------------------------------------------------- API

camara = Camara(os.getenv("CAMARA", CONFIG.get("camara", 0)))
cluster = Cluster(CONFIG["nodos"], CONFIG.get("timeout_inferencia_s", 5))
app = FastAPI(title="Caja de autoservicio")


@app.get("/api/config")
def config():
    return {k: CONFIG[k] for k in ("tienda", "caja", "moneda")}


@app.get("/api/catalogo")
def catalogo():
    return sorted(CATALOGO.values(), key=lambda p: p["nombre"])


@app.get("/api/estado")
def estado():
    return {"camara": camara.leer()[1], "nodos": cluster.estado()}


@app.get("/video")
def video():
    def cuadros():
        while True:
            cuadro, _ = camara.leer()
            if cuadro is not None:
                ok, jpg = cv2.imencode(".jpg", cuadro, [cv2.IMWRITE_JPEG_QUALITY, 70])
                yield b"--cuadro\r\nContent-Type: image/jpeg\r\n\r\n" + jpg.tobytes() + b"\r\n"
            time.sleep(1 / 15)

    return StreamingResponse(cuadros(), media_type="multipart/x-mixed-replace; boundary=cuadro")


@app.post("/api/escanear")
def escanear():
    cuadro, activa = camara.leer()
    if not activa:
        raise HTTPException(503, {"mensaje": "La cámara no está disponible. Revisa el cable USB "
                                              "o el valor de \"camara\" en config.json."})
    jpg = cv2.imencode(".jpg", cuadro, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
    inicio = time.perf_counter()
    respuesta, nodo, fallidos = cluster.detectar(jpg)
    total_ms = round((time.perf_counter() - inicio) * 1000)

    detecciones, items, sin_precio = [], {}, set()
    for d in respuesta["detecciones"]:
        clave = normalizar(d["clase"])
        producto = CATALOGO.get(clave)
        detecciones.append({**d, "nombre": producto["nombre"] if producto else d["clase"], "cobrado": bool(producto)})
        if producto:
            linea = items.setdefault(producto["clase"], {**producto, "cantidad": 0})
            linea["cantidad"] += 1
        elif clave not in IGNORAR:
            sin_precio.add(d["clase"])

    return {
        "nodo": nodo,
        "nodo_k3s": respuesta.get("nodo"),
        "ms_inferencia": respuesta.get("ms"),
        "ms_total": total_ms,
        "fallidos": fallidos,
        "imagen": "data:image/jpeg;base64," + base64.b64encode(jpg).decode(),
        "ancho": respuesta.get("ancho", cuadro.shape[1]),
        "alto": respuesta.get("alto", cuadro.shape[0]),
        "detecciones": detecciones,
        "items": list(items.values()),
        "sin_precio": sorted(sin_precio),
    }


@app.post("/api/ventas")
def registrar_venta(venta: Venta):
    lineas = []
    for linea in venta.items:
        producto = CATALOGO.get(normalizar(linea.clase))
        if not producto:
            raise HTTPException(400, {"mensaje": f"El producto \"{linea.clase}\" no está en precios.json"})
        lineas.append({"clase": producto["clase"], "nombre": producto["nombre"], "precio": producto["precio"],
                       "cantidad": linea.cantidad, "subtotal": round(producto["precio"] * linea.cantidad, 2)})
    total = round(sum(l["subtotal"] for l in lineas), 2)

    recibido = cambio = autorizacion = None
    if venta.metodo == "efectivo":
        if venta.recibido is None or venta.recibido < total:
            raise HTTPException(400, {"mensaje": "El efectivo recibido no cubre el total"})
        recibido, cambio = round(venta.recibido, 2), round(venta.recibido - total, 2)
    else:
        autorizacion = f"{random.randint(0, 999999):06d}"  # pago simulado: no se procesa ninguna tarjeta real

    fecha = datetime.now().isoformat(timespec="seconds")
    with conectar() as c:
        cursor = c.execute(
            "INSERT INTO ventas (fecha, items, total, metodo, recibido, cambio, autorizacion, nodo) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (fecha, json.dumps(lineas, ensure_ascii=False), total, venta.metodo, recibido, cambio,
             autorizacion, venta.nodo))
        fila = c.execute("SELECT * FROM ventas WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return fila_a_venta(fila)


@app.get("/api/ventas")
def ventas_de_hoy():
    hoy = datetime.now().date().isoformat()
    with conectar() as c:
        filas = c.execute("SELECT * FROM ventas WHERE fecha >= ? ORDER BY id DESC", (hoy,)).fetchall()
    ventas = [fila_a_venta(f) for f in filas]
    return {"ventas": ventas, "total": round(sum(v["total"] for v in ventas), 2)}


app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PUERTO", "8000")))
