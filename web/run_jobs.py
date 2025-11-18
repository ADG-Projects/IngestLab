from __future__ import annotations

import json
import logging
import shlex
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue
from typing import Any, Dict, List, Optional

from .config import relative_to_root

logger = logging.getLogger("chunking.run_jobs")


def _tail_text(value: Optional[str], limit: int = 8000) -> Optional[str]:
    if not value:
        return None
    text = value.strip()
    if len(text) <= limit:
        return text
    return text[-limit:]


@dataclass
class RunJob:
    id: str
    command: List[str]
    matches_path: Path
    metadata: Dict[str, Any] = field(default_factory=dict)
    status: str = "queued"
    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None
    stdout_tail: Optional[str] = None
    stderr_tail: Optional[str] = None
    error: Optional[str] = None
    result: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "status": self.status,
            "slug": self.metadata.get("slug_with_pages"),
            "pdf": self.metadata.get("pdf_name"),
            "pages": self.metadata.get("pages"),
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "command": self.metadata.get("display_command"),
            "stdout_tail": self.stdout_tail,
            "stderr_tail": self.stderr_tail,
            "result": self.result,
        }


class RunJobManager:
    def __init__(self) -> None:
        self.jobs: Dict[str, RunJob] = {}
        self.queue: Queue[RunJob] = Queue()
        self.lock = threading.Lock()
        worker = threading.Thread(target=self._worker, name="chunk-runner", daemon=True)
        worker.start()
        self.worker = worker
        logger.info("RunJobManager initialized")

    def _worker(self) -> None:
        while True:
            job = self.queue.get()
            try:
                self._execute(job)
            except Exception as exc:  # pragma: no cover - fail-safe logging
                logger.exception("Unexpected error in job worker (job_id=%s): %s", job.id, exc)
                job.status = "failed"
                job.error = f"Worker crashed: {exc}"
            finally:
                self.queue.task_done()

    def enqueue(
        self,
        *,
        command: List[str],
        matches_path: Path,
        metadata: Dict[str, Any],
    ) -> RunJob:
        job_id = uuid.uuid4().hex
        job = RunJob(
            id=job_id,
            command=list(command),
            matches_path=matches_path,
            metadata=dict(metadata),
        )
        job.metadata.setdefault("slug_with_pages", metadata.get("slug_with_pages"))
        display_cmd = " ".join(shlex.quote(part) for part in command)
        job.metadata["display_command"] = display_cmd
        with self.lock:
            self.jobs[job_id] = job
            self.queue.put(job)
        logger.info(
            "Queued chunking job %s for %s (pages=%s) slug=%s",
            job.id,
            metadata.get("pdf_name"),
            metadata.get("pages"),
            metadata.get("slug_with_pages"),
        )
        return job

    def _execute(self, job: RunJob) -> None:
        job.status = "running"
        job.started_at = time.time()
        logger.info(
            "Starting chunking job %s slug=%s command=%s",
            job.id,
            job.metadata.get("slug_with_pages"),
            job.metadata.get("display_command"),
        )
        proc = subprocess.run(job.command, capture_output=True, text=True)
        job.finished_at = time.time()
        job.stdout_tail = _tail_text(proc.stdout)
        job.stderr_tail = _tail_text(proc.stderr)
        if proc.returncode != 0:
            job.status = "failed"
            job.error = f"Run failed with exit code {proc.returncode}"
            logger.error(
                "Chunking job %s failed (exit=%s) slug=%s stderr_tail=%s",
                job.id,
                proc.returncode,
                job.metadata.get("slug_with_pages"),
                job.stderr_tail,
            )
            return
        self._finalize_success(job)

    def _finalize_success(self, job: RunJob) -> None:
        matches_path = job.matches_path
        payload: Optional[Dict[str, Any]]
        try:
            with matches_path.open("r", encoding="utf-8") as fh:
                payload = json.load(fh)
        except Exception as exc:  # pragma: no cover - corrupted match file
            payload = None
            logger.warning("Job %s succeeded but matches file could not be read: %s", job.id, exc)

        if isinstance(payload, dict):
            run_cfg = payload.get("run_config") or {}
            form_snapshot = job.metadata.get("form_snapshot") or {}
            run_cfg["form_snapshot"] = form_snapshot
            run_cfg["pdf"] = job.metadata.get("pdf_name")
            run_cfg["pages"] = job.metadata.get("pages")
            safe_tag = job.metadata.get("safe_tag")
            raw_tag = job.metadata.get("raw_tag")
            primary_lang = job.metadata.get("primary_language")
            if safe_tag:
                run_cfg["tag"] = safe_tag
            if raw_tag:
                run_cfg["variant_tag"] = raw_tag
            if primary_lang:
                run_cfg["primary_language"] = primary_lang
            payload["run_config"] = run_cfg
            try:
                with matches_path.open("w", encoding="utf-8") as fh:
                    json.dump(payload, fh, ensure_ascii=False, indent=2)
                    fh.write("\n")
            except Exception as exc:  # pragma: no cover - filesystem edge case
                logger.warning("Failed to rewrite matches file for job %s: %s", job.id, exc)

        slug_with_pages = job.metadata.get("slug_with_pages")
        page_tag = job.metadata.get("pages_tag")

        def _relpath(value: Optional[str]) -> Optional[str]:
            if not value:
                return None
            path = Path(value)
            if not path.exists():
                return None
            return relative_to_root(path)

        job.result = {
            "slug": slug_with_pages,
            "page_tag": page_tag,
            "tables_file": _relpath(job.metadata.get("tables_path")),
            "pdf_file": _relpath(job.metadata.get("trimmed_path")),
            "matches_file": _relpath(str(matches_path)),
            "chunks_file": _relpath(job.metadata.get("chunk_path")),
        }
        job.status = "succeeded"
        logger.info("Chunking job %s succeeded slug=%s", job.id, slug_with_pages)

    def list_jobs(self) -> List[Dict[str, Any]]:
        with self.lock:
            return [job.to_dict() for job in sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)]

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.lock:
            job = self.jobs.get(job_id)
            return job.to_dict() if job else None


RUN_JOB_MANAGER = RunJobManager()
