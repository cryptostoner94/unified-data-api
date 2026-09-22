FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /srv/data-api

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

# Fail closed: the container refuses to validate any key unless LICENSE_KEYS
# (JSON map) is provided at runtime. See .env.example.
ENV SQLITE_PATH=/srv/data-api/data/metering.db \
    LOG_LEVEL=INFO

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
