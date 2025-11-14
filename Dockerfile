# syntax=docker/dockerfile:1
FROM python:3.10-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    VIRTUAL_ENV=/app/.venv \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH"

WORKDIR /app

# System deps for Unstructured + OCR + OpenCV + file type detection
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    poppler-utils \
    tesseract-ocr tesseract-ocr-ara \
    libmagic1 \
    libheif1 libde265-0 \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
  && rm -rf /var/lib/apt/lists/*

## Install uv (fast Python package manager) and create venv
# uv places the binary in /root/.local/bin by default
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    python -m venv "$VIRTUAL_ENV"
ENV PATH="/root/.local/bin:$PATH"

# Copy lockfiles first for better layer caching and install deps
COPY pyproject.toml uv.lock ./

# Default: include hi_res extras. To build a minimal image, pass
#   --build-arg WITH_HIRES=0 --build-arg DISABLE_HI_RES=1
ARG WITH_HIRES=1
ARG DISABLE_HI_RES
RUN if [ "${WITH_HIRES}" = "1" ]; then \
      echo "Installing hires extras"; \
      uv sync --frozen --no-dev --extra hires; \
    else \
      echo "Installing minimal deps (no hires)"; \
      uv sync --frozen --no-dev; \
    fi
ENV DISABLE_HI_RES=${DISABLE_HI_RES}

# Copy the rest of the app
COPY . .

# Pre-fetch vendor assets to avoid runtime CDN fetches on cold start
RUN "$VIRTUAL_ENV/bin/python" - <<'PY'
from web.serve import ensure_pdfjs_assets, ensure_chartjs_assets
ensure_pdfjs_assets()
ensure_chartjs_assets()
print("Vendor assets cached")
PY

# Drop build caches to reduce final image size
RUN rm -rf /root/.cache/uv /root/.cache/pip || true

EXPOSE 8000
ENV PORT=8000
CMD ["sh","-lc","uvicorn web.serve:app --host 0.0.0.0 --port ${PORT:-8000}"]
