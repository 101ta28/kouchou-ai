"""Private, versioned evidence for analysis runs and existing report edits.

The archive is deliberately outside outputs/. Records describe observed software
and data; they are not a signature, an attestation, or proof of model weights.
"""

from __future__ import annotations

import contextvars
import hashlib
import importlib.metadata
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from analysis_core.services.error_summary import redact_secrets

SCHEMA_VERSION = 1
_CURRENT: contextvars.ContextVar[AuditSession | None] = contextvars.ContextVar("audit_session", default=None)
_ID = re.compile(r"^[0-9]{8}T[0-9]{12}Z-[a-f0-9]{32}$")
# Include current builtin artifacts, including optional steps, but never logs,
# credentials, arbitrary adjacent files, or the HTML used only for CLI preview.
ARTIFACTS = (
    "args.csv",
    "relations.csv",
    "embeddings.pkl",
    "umap_model.pkl",
    "hierarchical_clusters.csv",
    "hierarchical_initial_labels.csv",
    "hierarchical_merge_labels.csv",
    "hierarchical_overview.txt",
    "hierarchical_result.json",
    "public_result.json",
    "hierarchical_status.json",
    "opinion_classifications.csv",
    "opinion_classification_summary.json",
    "opinion_stances.csv",
    "opinion_stance_summary.json",
    "opinion_novelty.csv",
    "opinion_novelty_summary.json",
    "translations.json",
    "visualization_config.json",
    "final_result_with_comments.csv",
)
HASHED_ARTIFACTS = {"hierarchical_result.json", "public_result.json"}
RUNTIME_SETTINGS = (
    "OPENAI_BASE_URL",
    "OPENAI_USE_FLEX",
    "OPENROUTER_FORCE_JSON_FALLBACK",
    "AZURE_CHATCOMPLETION_ENDPOINT",
    "AZURE_CHATCOMPLETION_DEPLOYMENT_NAME",
    "AZURE_CHATCOMPLETION_MODEL_NAME",
    "AZURE_CHATCOMPLETION_VERSION",
    "AZURE_CHATCOMPLETION_REASONING",
    "AZURE_EMBEDDING_ENDPOINT",
    "AZURE_EMBEDDING_DEPLOYMENT_NAME",
    "AZURE_EMBEDDING_VERSION",
    "LOCAL_LLM_REASONING_EFFORT",
    "NUMBA_CPU_NAME",
)


class AuditError(RuntimeError):
    pass


class AuditBusyError(AuditError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _secret_key(key: str) -> bool:
    name = key.lower().replace("-", "_")
    return name in {
        "authorization",
        "cookie",
        "password",
        "secret",
        "token",
        "api_key",
        "apikey",
        "access_token",
        "credentials",
    } or name.endswith(("_api_key", "_password", "_secret", "_access_token", "_connection_string"))


def sanitize(value: Any, secrets: tuple[str, ...] = ()) -> Any:
    """Keep readable values while excluding credentials and unbounded old status."""
    if isinstance(value, dict):
        local_secrets = tuple(str(v) for k, v in value.items() if _secret_key(str(k)) and v)
        return {
            str(k): sanitize(v, secrets + local_secrets)
            for k, v in value.items()
            if not _secret_key(str(k))
            and k not in {"previous", "error_stack_trace", "error_log_excerpt"}
            and not str(k).startswith("_audit")
        }
    if isinstance(value, (list, tuple)):
        return [sanitize(v, secrets) for v in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[REDACTED]")
        # URLs may contain embedded credentials or signed query parameters.
        value = re.sub(r"(https?://)[^/@\s]+:[^/@\s]+@", r"\1[REDACTED]@", value)
        value = re.sub(r"(?i)([?&](?:sig|token|key|api_key|secret)=)[^&\s]+", r"\1[REDACTED]", value)
        return value
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)


def _private_dir(path: Path) -> None:
    if path.is_symlink():
        raise AuditError("Audit directories must not be symbolic links")
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def _write_json(path: Path, data: Any) -> None:
    """Publish complete records atomically; sync before publishing the name."""
    _private_dir(path.parent)
    fd, temporary = tempfile.mkstemp(prefix=".writing-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _sync_directory(path: Path) -> None:
    if os.name != "nt":
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def software_record() -> dict[str, Any]:
    import analysis_core

    package = Path(analysis_core.__file__).parent
    digest = hashlib.sha256()
    for path in sorted(package.rglob("*")):
        if path.is_file() and path.suffix in {".py", ".json", ".txt", ".yaml", ".jinja2"}:
            digest.update(path.relative_to(package).as_posix().encode() + b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    record: dict[str, Any] = {
        "analysis_core_version": analysis_core.__version__,
        "analysis_core_source_sha256": digest.hexdigest(),
        "source_digest_format": "sorted-relative-path-NUL-content-NUL-v1",
        "python": platform.python_version(),
        "platform": platform.platform(),
        "dependencies": dict(
            sorted((d.metadata["Name"], d.version) for d in importlib.metadata.distributions() if d.metadata["Name"])
        ),
        "git_commit": None,
        "git_dirty": None,
        "container_image": os.environ.get("KOUCHOU_IMAGE_DIGEST") or None,
        "container_image_source": "operator_supplied",
    }
    try:

        def git(*args: str) -> str:
            return subprocess.check_output(
                ["git", "--no-optional-locks", "-C", str(package), *args],
                stderr=subprocess.DEVNULL,
                timeout=5,
                text=True,
            ).strip()

        record["git_commit"] = git("rev-parse", "HEAD")
        record["git_dirty"] = bool(git("status", "--porcelain", "--untracked-files=normal"))
    except (OSError, subprocess.SubprocessError):
        pass
    return record


class AuditStore:
    def __init__(self, report_dir: Path):
        self.report_dir = Path(report_dir).resolve()
        output_base = self.report_dir.parent
        default_root = output_base.with_name(
            "audits" if output_base.name == "outputs" else output_base.name + ".audits"
        )
        root = Path(os.environ.get("KOUCHOU_AUDIT_DIR") or default_root).absolute()
        if root.resolve().is_relative_to(self.report_dir.parent):
            raise AuditError("KOUCHOU_AUDIT_DIR must be outside the report outputs directory")
        self.root = root
        self.path = root / self.report_dir.name
        if self.root.is_symlink() or self.path.is_symlink():
            raise AuditError("Audit directories must not be symbolic links")

    def record_dir(self, run_id: str) -> Path:
        if not _ID.fullmatch(run_id):
            raise ValueError("Invalid audit run ID")
        path = self.path / run_id
        if path.is_symlink():
            raise AuditError("Audit records must not be symbolic links")
        return path

    def read(self, run_id: str) -> dict[str, Any]:
        directory = self.record_dir(run_id)
        path = directory / "manifest.json"
        if not path.exists():
            path = directory / "started.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def list_records(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        return [
            self.read(p.name)
            for p in sorted(self.path.iterdir(), reverse=True)
            if _ID.fullmatch(p.name) and ((p / "started.json").exists() or (p / "manifest.json").exists())
        ]

    def verify(self, run_id: str) -> dict[str, Any]:
        record = self.read(run_id)
        failures = (
            [] if record["status"] != "incomplete" else [{"path": "manifest.json", "reason": "incomplete_operation"}]
        )
        hashed = 0
        for item in record.get("files", []):
            path = self.file(run_id, item["path"])
            if not path.is_file():
                failures.append({"path": item["path"], "reason": "missing"})
            elif "sha256" in item:
                hashed += 1
                if sha256(path) != item["sha256"]:
                    failures.append({"path": item["path"], "reason": "sha256_mismatch"})
            elif path.stat().st_size != item["bytes"]:
                failures.append({"path": item["path"], "reason": "size_mismatch"})
        return {
            "run_id": run_id,
            "status": record["status"],
            "valid": not failures,
            "hashed_files_checked": hashed,
            "verification_scope": "SHA-256 where recorded; existence and size only for other files. Not an attestation.",
            "failures": failures,
        }

    def file(self, run_id: str, relative: str) -> Path:
        directory = self.record_dir(run_id)
        path = directory / relative
        if (
            Path(relative).is_absolute()
            or ".." in Path(relative).parts
            or path.is_symlink()
            or not path.resolve().is_relative_to(directory.resolve())
        ):
            raise ValueError("Invalid audit file path")
        return path

    def export(self, run_id: str, destination: Path) -> None:
        record = self.read(run_id)
        directory = self.record_dir(run_id)
        if record["status"] == "incomplete":
            raise AuditError("The audit operation has no final manifest yet")
        # Export only enumerated evidence; never arbitrary files planted in the directory.
        with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(directory / "manifest.json", "manifest.json")
            for item in record.get("files", []):
                archive.write(self.file(run_id, item["path"]), item["path"])


class AuditSession:
    def __init__(
        self, report_dir: Path, kind: str, config: dict[str, Any] | None = None, input_path: Path | None = None
    ):
        self.store = AuditStore(report_dir)
        self.config = config or {}
        self.input_path = input_path
        self.run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ-") + uuid.uuid4().hex
        self.directory = self.store.record_dir(self.run_id)
        self.success = True
        self.error: str | None = None
        self._lock = None
        self._token = None
        self._model_lock = threading.Lock()
        self.active_step: str | None = None
        self.record: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "run_id": self.run_id,
            "report": self.store.report_dir.name,
            "kind": kind,
            "started_at": utc_now(),
            "finished_at": None,
            "status": "incomplete",
            "parent_run_id": None,
            "files": [],
            "steps": [],
        }

    def __enter__(self) -> AuditSession:
        if _CURRENT.get() is not None:
            raise AuditError("Nested audit sessions are not supported")
        _private_dir(self.store.root)
        _private_dir(self.store.path)
        lock_path = self.store.path / ".lock"
        if lock_path.is_symlink():
            raise AuditError("Audit lock must not be a symbolic link")
        self._lock = os.fdopen(os.open(lock_path, os.O_RDWR | os.O_CREAT, 0o600), "r+b")
        try:
            if os.name == "nt":
                import msvcrt

                if os.fstat(self._lock.fileno()).st_size == 0:
                    self._lock.write(b"\0")
                    self._lock.flush()
                self._lock.seek(0)
                msvcrt.locking(self._lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self._lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            self._lock.close()
            self._lock = None
            raise AuditBusyError("Another analysis or edit is in progress for this report") from exc
        try:
            previous = self.store.list_records()
            if previous:
                self.record["parent_run_id"] = previous[0]["run_id"]
            _private_dir(self.directory)
            _write_json(self.directory / "started.json", self.record)
            self.record["software"] = software_record()
            self.record["runtime_settings"] = sanitize({k: os.environ[k] for k in RUNTIME_SETTINGS if k in os.environ})
            self.write_data("config.json", self.config)
            if self.input_path is not None and self.input_path.exists():
                self.snapshot(self.input_path, "inputs/" + self.input_path.name, hashed=True)
            self.capture_outputs("before")
            _write_json(self.directory / "started.json", self.record)
            self._token = _CURRENT.set(self)
            return self
        except BaseException:
            self._lock.close()
            self._lock = None
            raise

    def write_data(self, relative: str, value: Any) -> None:
        path = self.store.file(self.run_id, relative)
        clean = sanitize(value)
        _write_json(path, clean)
        self._register(path, relative, sanitized=clean != value)

    def _register(self, path: Path, relative: str, hashed: bool = False, **extra: Any) -> None:
        entry = {"path": relative, "bytes": path.stat().st_size, **extra}
        if hashed:
            entry["sha256"] = sha256(path)
        self.record["files"] = [f for f in self.record["files"] if f["path"] != relative] + [entry]

    def snapshot(self, source: Path, relative: str, hashed: bool = False) -> None:
        source = Path(source)
        if source.is_symlink() or not source.is_file():
            raise AuditError(f"Cannot archive a non-regular file: {source.name}")
        target = self.store.file(self.run_id, relative)
        _private_dir(target.parent)
        redacted = False
        if source.suffix == ".json":
            raw = source.read_text(encoding="utf-8", errors="replace")
            try:
                original = json.loads(raw)
            except ValueError:
                # A failed previous run may have left malformed JSON. Preserve it
                # as diagnostic evidence without preventing a repair/re-run.
                clean_text = redact_secrets(raw, (self.config.get("user_api_key"),))
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "w", encoding="utf-8") as stream:
                    stream.write(clean_text)
                    stream.flush()
                    os.fsync(stream.fileno())
                self._register(target, relative, hashed, redacted=clean_text != raw, parse_status="invalid_json")
                return
            if isinstance(original, dict) and isinstance(original.get("config"), dict):
                clean = {**original, "config": sanitize(original["config"])}
            else:
                clean = sanitize(original)
            redacted = original != clean
            if redacted:
                _write_json(target, clean)
            else:
                self._copy(source, target)
        else:
            self._copy(source, target)
        self._register(target, relative, hashed, redacted=redacted)

    def archive_input(self, source: Path, name: str | None = None) -> Path:
        relative = (Path("inputs") / (name or source.name)).as_posix()
        self.snapshot(source, relative, hashed=True)
        return self.store.file(self.run_id, relative)

    @staticmethod
    def _copy(source: Path, target: Path) -> None:
        fd, temporary = tempfile.mkstemp(prefix=".copy-", dir=target.parent)
        try:
            with source.open("rb") as reader, os.fdopen(fd, "wb") as writer:
                shutil.copyfileobj(reader, writer, 1024 * 1024)
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(temporary, target)
            _sync_directory(target.parent)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def capture_outputs(self, phase: str) -> None:
        for name in ARTIFACTS:
            source = self.store.report_dir / name
            if source.exists():
                self.snapshot(source, f"{phase}/{name}", hashed=name in HASHED_ARTIFACTS)

    def step(self, name: str, **data: Any) -> None:
        if data.get("status") == "started":
            self.active_step = name
        entry = sanitize({"step": name, "recorded_at": utc_now(), **data})
        self.record["steps"].append(entry)
        self.write_data(f"steps/{len(self.record['steps']):04d}.json", entry)
        if (self.directory / "model_responses.jsonl").exists():
            self._register(self.directory / "model_responses.jsonl", "model_responses.jsonl")
        # A process killed between steps still leaves the exact completed evidence list.
        _write_json(self.directory / "started.json", self.record)

    def model_response(self, provider: str, response: Any, requested_model: str | None = None) -> None:
        """Record only provider metadata, never credential headers or hidden state."""
        entry = {"provider": provider, "step": self.active_step, "recorded_at": utc_now()}
        if requested_model is not None:
            entry["requested_model"] = requested_model
        for key in ("id", "model", "model_version", "system_fingerprint", "_request_id"):
            value = response.get(key) if isinstance(response, dict) else getattr(response, key, None)
            if isinstance(value, (str, int)):
                entry[key.lstrip("_")] = value
        with self._model_lock:
            path = self.directory / "model_responses.jsonl"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())

    def __exit__(self, exc_type, exc, tb) -> bool:
        try:
            self.write_data("final_config.json", self.config)
            self.capture_outputs("after")
            model_records = self.directory / "model_responses.jsonl"
            if model_records.exists():
                self._register(model_records, "model_responses.jsonl")
            diagnostics = (
                self.store.report_dir.parent.parent / "diagnostics" / f"{self.store.report_dir.name}-extraction.jsonl"
            )
            if diagnostics.exists() and any(s.get("step") == "extraction" for s in self.record["steps"]):
                self.snapshot(diagnostics, "diagnostics/extraction.jsonl")
            self.record.update(
                {
                    "status": "failed" if exc is not None or not self.success else "completed",
                    "finished_at": utc_now(),
                    "error": redact_secrets(str(exc or self.error), (self.config.get("user_api_key"),))
                    if exc or self.error
                    else None,
                }
            )
            _write_json(self.directory / "manifest.json", self.record)
        finally:
            if self._token is not None:
                _CURRENT.reset(self._token)
            if self._lock is not None:
                self._lock.close()
        return False


def current_session() -> AuditSession | None:
    return _CURRENT.get()


def record_model_response(provider: str, response: Any, requested_model: str | None = None) -> None:
    if session := current_session():
        session.model_response(provider, response, requested_model)
