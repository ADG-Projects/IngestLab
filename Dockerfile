# syntax=docker/dockerfile:1.4

ARG PYTHON_VERSION=3.11

FROM public.ecr.aws/docker/library/python:${PYTHON_VERSION}-slim AS runtime

ARG WITH_HIRES=1
ARG DISABLE_HI_RES=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    APP_HOME=/app \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:/root/.local/bin:$PATH" \
    DISABLE_HI_RES=${DISABLE_HI_RES} \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata

WORKDIR /app

# Install system dependencies needed for hi_res layout (OpenCV, Tesseract, Poppler, HEIF)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        poppler-utils \
        tesseract-ocr \
        tesseract-ocr-ara \
        tesseract-ocr-script-arab \
        libgl1 \
        libglib2.0-0 \
        libsm6 \
        libxext6 \
        libxrender1 \
        libheif1 \
        && rm -rf /var/lib/apt/lists/*

# Install uv so all Python commands use the same resolver/runtime
RUN pip install --no-cache-dir uv

# Pre-install Python dependencies with full extras (unstructured + hires)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --extra full && \
    uv pip uninstall opencv-python || true && \
    uv pip install --no-deps opencv-python-headless==4.11.0.86 && \
    if [ "$WITH_HIRES" = "0" ]; then \
        uv pip uninstall unstructured-inference || true; \
    fi

# Copy the rest of the application after deps to preserve cached layers
COPY . .

# Ensure a dotenv file is present inside the image (use example if none provided)
RUN if [ -f .env ]; then \
        echo "using existing .env"; \
    elif [ -f .env.example ]; then \
        cp .env.example .env; \
    else \
        touch .env; \
    fi

EXPOSE 8000

CMD ["uv", "run", "python", "main.py"]
