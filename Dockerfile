# syntax=docker/dockerfile:1.4

ARG PYTHON_VERSION=3.11

FROM public.ecr.aws/docker/library/python:${PYTHON_VERSION}-slim AS runtime

ARG WITH_HIRES=1
ARG DISABLE_HI_RES=0
# Set to 1 to include SAM3 local server dependencies (torch, transformers)
# This adds ~3GB to the image - only needed if running SAM3 locally
ARG WITH_SAM3_LOCAL=0

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    APP_HOME=/app \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:/root/.local/bin:$PATH"

WORKDIR /app

# Install system dependencies needed for hi_res layout (OpenCV, Tesseract, Poppler, HEIF)
# Also install Node.js for mermaid-cli (diagram validation) and git for uv
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        curl \
        git \
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
        nodejs \
        npm \
        && rm -rf /var/lib/apt/lists/*

# Configure git to use GitHub token for private repos (token passed via build arg)
ARG GH_TOKEN
RUN if [ -n "$GH_TOKEN" ]; then \
        git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"; \
    fi

# Install uv so all Python commands use the same resolver/runtime
RUN pip install --no-cache-dir uv

# Pre-install Python dependencies
# By default, only core deps (no torch/transformers for smaller image)
# Use WITH_SAM3_LOCAL=1 to include local SAM3 server deps
COPY pyproject.toml uv.lock ./
RUN if [ "$WITH_SAM3_LOCAL" = "1" ]; then \
        echo "Installing with SAM3 local server support (full)..." && \
        uv sync --frozen --no-dev --extra full; \
    else \
        echo "Installing core dependencies (remote SAM3 only)..." && \
        uv sync --frozen --no-dev; \
    fi && \
    uv pip uninstall opencv-python || true && \
    uv pip install --no-deps opencv-python-headless==4.11.0.86 && \
    if [ "$WITH_HIRES" = "0" ]; then \
        uv pip uninstall unstructured-inference || true; \
    fi

# Copy the rest of the application
COPY . .

# Install Node.js dependencies (mermaid-cli for diagram validation)
RUN npm install --omit=dev

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
