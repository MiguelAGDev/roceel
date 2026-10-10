FROM python:3.12-slim
WORKDIR /app
# Los logs salen al momento en `docker compose logs`
ENV PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app app
# Por omisión la API. El consumidor usa la misma imagen con `python -m app.consumer` (ver docker-compose.yml).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
