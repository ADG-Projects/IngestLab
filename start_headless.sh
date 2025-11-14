#!/usr/bin/env bash
set -euo pipefail

echo "[start] ensuring OpenCV headless and starting Uvicorn"

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

# Fallback: pip-based environment
python -m pip uninstall -y opencv-python || true
python -m pip install --no-deps opencv-python-headless==4.11.0.86
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-8000}"

