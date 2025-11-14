#!/usr/bin/env bash
set -euo pipefail

echo "[start] ensuring OpenCV headless and starting Uvicorn"

# Prefer project virtualenv if present
if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
  PIP=".venv/bin/pip"
  UVICORN=".venv/bin/uvicorn"
else
  PY="python3"
  PIP="python3 -m pip"
  UVICORN="uvicorn"
fi

have_uv=1
if ! command -v uv >/dev/null 2>&1; then
  have_uv=0
  echo "[start] 'uv' not found; falling back to pip"
fi

# If using uv, ensure deps and swap to headless OpenCV
if [ "$have_uv" -eq 1 ]; then
  # Resolve and install dependencies per pyproject/uv.lock (non-fatal if already installed)
  uv sync || true
  # Swap OpenCV for the headless build to avoid libGL requirements in headless containers
  uv pip uninstall -y opencv-python || true
  uv pip install --no-deps opencv-python-headless==4.11.0.86
  exec uv run uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"
fi

# Fallback: pip-based environment (use venv if available, else create it)
if [ ! -x "$PY" ]; then
  # Create a local venv to avoid PEP 668 constraints
  python3 -m venv .venv
  PY=".venv/bin/python"
  PIP=".venv/bin/pip"
  UVICORN=".venv/bin/uvicorn"
fi

$PY -m pip install -U pip setuptools wheel || true
# Install project (pulls dependencies from pyproject)
$PIP install /app || true
# Swap OpenCV to headless variant
$PIP uninstall -y opencv-python || true
$PIP install --no-deps opencv-python-headless==4.11.0.86
exec $UVICORN main:app --host 0.0.0.0 --port "${PORT:-8000}"
