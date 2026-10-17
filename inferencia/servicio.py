"""Servicio de inferencia del clúster.

Recibe una imagen JPEG por POST /detectar y responde con las detecciones de YOLO
y el nombre del nodo que la procesó. Corre como DaemonSet de K3s: una réplica por nodo.
"""
import os
import random
import socket
import threading
import time

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

NODO = os.getenv("NODE_NAME") or socket.gethostname()
MODELO = os.getenv("MODELO", "/modelos/unificado_v2_ncnn_model")
IMGSZ = int(os.getenv("IMGSZ", "320"))
CONF = float(os.getenv("CONF", "0.5"))
# SIMULADO=1 responde detecciones al azar sin cargar el modelo (para probar la caja sin YOLO).
SIMULADO = os.getenv("SIMULADO") == "1"

app = FastAPI(title="Inferencia YOLO")
candado = threading.Lock()  # el modelo no es seguro para usarlo desde varios hilos a la vez

if SIMULADO:
    modelo = None
    NOMBRES = {i: n for i, n in enumerate(
        ["coca-cola", "pepsi", "sprite", "fanta", "avocado", "tomato", "kiwi", "person", "hand"])}
else:
    from ultralytics import YOLO

    modelo = YOLO(MODELO, task="detect")
    modelo.predict(np.zeros((IMGSZ, IMGSZ, 3), np.uint8), imgsz=IMGSZ, verbose=False)  # calentamiento
    NOMBRES = modelo.names


def predecir(imagen):
    with candado:
        r = modelo.predict(imagen, imgsz=IMGSZ, conf=CONF, verbose=False)[0]
    return [
        {"clase": NOMBRES[int(c)], "confianza": round(float(p), 3), "caja": [round(v, 1) for v in xyxy]}
        for xyxy, c, p in zip(r.boxes.xyxy.tolist(), r.boxes.cls.tolist(), r.boxes.conf.tolist())
    ]


def simular(imagen):
    time.sleep(random.uniform(0.08, 0.2))
    alto, ancho = imagen.shape[:2]
    detecciones = []
    for _ in range(random.randint(1, 4)):
        w, h = random.uniform(0.12, 0.25) * ancho, random.uniform(0.25, 0.45) * alto
        x, y = random.uniform(0, ancho - w), random.uniform(0, alto - h)
        detecciones.append({
            "clase": random.choice(list(NOMBRES.values())),
            "confianza": round(random.uniform(0.55, 0.97), 3),
            "caja": [round(x, 1), round(y, 1), round(x + w, 1), round(y + h, 1)],
        })
    return detecciones


@app.post("/detectar")
async def detectar(request: Request):
    datos = await request.body()
    imagen = cv2.imdecode(np.frombuffer(datos, np.uint8), cv2.IMREAD_COLOR)
    if imagen is None:
        raise HTTPException(400, "El cuerpo de la petición no es una imagen JPEG o PNG válida")
    inicio = time.perf_counter()
    detecciones = await run_in_threadpool(simular if SIMULADO else predecir, imagen)
    return {
        "nodo": NODO,
        "ms": round((time.perf_counter() - inicio) * 1000, 1),
        "ancho": imagen.shape[1],
        "alto": imagen.shape[0],
        "detecciones": detecciones,
    }


@app.get("/salud")
def salud():
    return {"nodo": NODO, "modelo": "simulado" if SIMULADO else MODELO, "imgsz": IMGSZ, "clases": len(NOMBRES)}


@app.get("/clases")
def clases():
    """Nombres de clase del modelo: son las claves que se usan en precios.json."""
    return sorted(NOMBRES.values())
