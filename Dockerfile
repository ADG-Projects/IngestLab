# syntax=docker/dockerfile:1.4

ARG PYTHON_VERSION=3.11

FROM public.ecr.aws/docker/library/python:${PYTHON_VERSION}-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    APP_HOME=/app \
    VIRTUAL_ENV=/app/.venv \
    PATH="/app/.venv/bin:/root/.local/bin:$PATH"

WORKDIR /app

# Install minimal system dependencies
# - git: required for uv to install dependencies from git repositories
# - build-essential: required for building some Python packages
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        git \
        && rm -rf /var/lib/apt/lists/*

# Install uv for Python dependency management
RUN pip install --no-cache-dir uv

# Pre-install Python dependencies (cached layer)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

# Copy the rest of the application
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
