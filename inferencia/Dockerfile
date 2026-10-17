FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# PyTorch para CPU: más liviano que la versión con CUDA y existe para arm64 (Pi) y amd64 (VM)
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir -r requirements.txt

COPY servicio.py .

# El modelo no va dentro de la imagen: se monta desde /opt/caja/modelos de cada nodo
ENV MODELO=/modelos/unificado_v2_ncnn_model
EXPOSE 8001
CMD ["uvicorn", "servicio:app", "--host", "0.0.0.0", "--port", "8001"]
