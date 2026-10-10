# Se construye desde la raíz del repositorio (docker-compose.yml: context ".").

# 1) Pantallas: compila frontend/ (React + Vite) a archivos estáticos.
FROM node:22-alpine AS ui
WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# 2) Servicio: API + consumidor (misma imagen, distinto comando).
FROM python:3.12-slim
WORKDIR /app
# Los logs salen al momento en `docker compose logs`
ENV PYTHONUNBUFFERED=1
# Certificado autofirmado para servir por HTTPS (:8443): la cámara del celular solo abre en HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/* \
 && mkdir /certs \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=inventario" \
      -keyout /certs/key.pem -out /certs/cert.pem
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/app app
COPY --from=ui /ui/dist static
# Por omisión la API. El consumidor usa la misma imagen con `python -m app.consumer` (ver docker-compose.yml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
