import json
import os
import subprocess
import sys
import zipfile

import pytest

from analysis_core.audit import AuditError, AuditSession, AuditStore, sha256
from analysis_core.audit_cli import main
from analysis_core.orchestrator import PipelineOrchestrator, PipelineResult


@pytest.fixture
def report_dir(tmp_path, monkeypatch):
    monkeypatch.delenv("KOUCHOU_AUDIT_DIR", raising=False)
    report = tmp_path / "outputs" / "report"
    report.mkdir(parents=True)
    return report


def test_versions_preserve_input_config_outputs_and_parent(report_dir, tmp_path):
    source = tmp_path / "source.csv"
    source.write_text("comment-id,comment-body\nc1,バスを増やす\n")
    result = report_dir / "hierarchical_result.json"
    with AuditSession(
        report_dir, "analysis", {"model": "model-a", "extraction": {"prompt": "原文に忠実に"}}, source
    ) as first:
        result.write_text('{"overview": "first"}')
    first_bytes = (first.directory / "after/hierarchical_result.json").read_bytes()
    with AuditSession(report_dir, "analysis", {"model": "model-b"}, source) as second:
        result.write_text('{"overview": "second"}')
    store = AuditStore(report_dir)
    assert store.read(second.run_id)["parent_run_id"] == first.run_id
    assert store.read(first.run_id)["status"] == "completed"
    assert (first.directory / "after/hierarchical_result.json").read_bytes() == first_bytes
    assert json.loads((first.directory / "config.json").read_text())["extraction"]["prompt"] == "原文に忠実に"
    input_entry = next(f for f in store.read(first.run_id)["files"] if f["path"].startswith("inputs/"))
    assert input_entry["sha256"] == sha256(source)
    assert store.verify(first.run_id)["valid"]
    assert not (report_dir / "audits").exists()
    if os.name != "nt":
        assert first.directory.stat().st_mode & 0o777 == 0o700
        assert (first.directory / "config.json").stat().st_mode & 0o777 == 0o600


def test_credentials_are_not_archived_even_in_old_result(report_dir):
    secret = "private-key-for-this-test"
    config = {"user_api_key": secret, "nested": {"api_key": secret}, "prompt": f"value {secret}"}
    (report_dir / "hierarchical_result.json").write_text(json.dumps({"config": config}))
    with AuditSession(report_dir, "analysis", config) as session:
        pass
    for path in session.directory.rglob("*.json"):
        assert secret not in path.read_text()
    entry = next(f for f in session.record["files"] if f["path"] == "before/hierarchical_result.json")
    assert entry["redacted"] is True


@pytest.mark.parametrize("exception", [RuntimeError("failed"), KeyboardInterrupt()])
def test_failures_and_interrupts_keep_partial_evidence(report_dir, exception):
    with pytest.raises(type(exception)):
        with AuditSession(report_dir, "analysis") as session:
            (report_dir / "args.csv").write_text("arg-id,argument\na1,test\n")
            session.step("extraction", status="started")
            raise exception
    record = AuditStore(report_dir).read(session.run_id)
    assert record["status"] == "failed"
    assert (session.directory / "after/args.csv").exists()
    assert record["steps"][0]["step"] == "extraction"


def test_killed_process_is_incomplete_and_does_not_hold_lock(report_dir):
    code = "from analysis_core.audit import AuditSession; from pathlib import Path; import os; "
    code += (
        "session = AuditSession(Path(os.environ['AUDIT_TEST_REPORT']), 'analysis'); session.__enter__(); os._exit(7)"
    )
    result = subprocess.run([sys.executable, "-c", code], env={**os.environ, "AUDIT_TEST_REPORT": str(report_dir)})
    assert result.returncode == 7
    store = AuditStore(report_dir)
    record = store.list_records()[0]
    assert record["status"] == "incomplete"
    assert not store.verify(record["run_id"])["valid"]
    with AuditSession(report_dir, "analysis"):
        pass
    assert len(store.list_records()) == 2


def test_concurrent_operation_is_rejected_without_replacing_record(report_dir):
    with AuditSession(report_dir, "analysis") as first:
        code = "from analysis_core.audit import AuditSession, AuditBusyError; from pathlib import Path; import os\n"
        code += "try:\n with AuditSession(Path(os.environ['AUDIT_TEST_REPORT']), 'edit'): pass\n"
        code += "except AuditBusyError: raise SystemExit(9)\n"
        process = subprocess.run([sys.executable, "-c", code], env={**os.environ, "AUDIT_TEST_REPORT": str(report_dir)})
        assert process.returncode == 9
        assert len(AuditStore(report_dir).list_records()) == 1
    assert AuditStore(report_dir).read(first.run_id)["status"] == "completed"


def test_hash_verification_and_private_export(report_dir, tmp_path):
    with AuditSession(report_dir, "analysis") as session:
        (report_dir / "public_result.json").write_text('{"overview":"original"}')
    store = AuditStore(report_dir)
    path = session.directory / "after/public_result.json"
    path.write_text('{"overview":"modified"}')
    checked = store.verify(session.run_id)
    assert not checked["valid"]
    assert checked["failures"] == [{"path": "after/public_result.json", "reason": "sha256_mismatch"}]
    (session.directory / "unlisted-secret.txt").write_text("do not export")
    destination = tmp_path / "export.zip"
    assert (
        main(
            [
                "--report-dir",
                str(report_dir),
                "export",
                session.run_id,
                "--output",
                str(destination),
                "--audience",
                "internal",
            ]
        )
        == 0
    )
    with zipfile.ZipFile(destination) as archive:
        assert "manifest.json" in archive.namelist()
        assert "unlisted-secret.txt" not in archive.namelist()
    assert main(["--report-dir", str(report_dir), "export", session.run_id, "--output", str(destination)]) == 1
    assert main(["--report-dir", str(report_dir), "verify", session.run_id]) == 1


def test_archive_rejects_public_location_paths_and_symlinks(report_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("KOUCHOU_AUDIT_DIR", str(report_dir / "audit"))
    with pytest.raises(AuditError):
        AuditStore(report_dir)
    monkeypatch.delenv("KOUCHOU_AUDIT_DIR")
    with AuditSession(report_dir, "analysis") as session:
        with pytest.raises(ValueError):
            session.write_data("../../outside.json", {})
    store = AuditStore(report_dir)
    with pytest.raises(ValueError):
        store.read("../../etc/passwd")
    if os.name != "nt":
        target = tmp_path / "secret.txt"
        target.write_text("secret")
        (report_dir / "args.csv").symlink_to(target)
        with pytest.raises(AuditError):
            with AuditSession(report_dir, "analysis"):
                pass


def test_analysis_reads_saved_input_even_if_original_changes(report_dir, tmp_path):
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    source = inputs / "report.csv"
    source.write_text("comment-id,comment-body\nc1,original\n")
    config = {"input": "report", "output_dir": "report", "model": "model-a"}
    orchestrator = PipelineOrchestrator(config, output_base_dir=report_dir.parent, input_base_dir=inputs)

    def execute():
        source.write_text("comment-id,comment-body\nc1,changed\n")
        assert "original" in (orchestrator.input_base_dir / "report.csv").read_text()
        return PipelineResult(success=True)

    result = orchestrator._run_with_audit(execute)
    assert result.success
    assert orchestrator.input_base_dir == inputs
    record = AuditStore(report_dir).list_records()[0]
    assert record["status"] == "completed"


def test_archive_write_failure_prevents_success(report_dir, monkeypatch):
    from analysis_core import audit

    original = audit._write_json

    def fail_final(path, data):
        if path.name == "manifest.json":
            raise OSError("disk full")
        original(path, data)

    monkeypatch.setattr(audit, "_write_json", fail_final)
    with pytest.raises(OSError, match="disk full"):
        with AuditSession(report_dir, "analysis"):
            pass
    assert AuditStore(report_dir).list_records()[0]["status"] == "incomplete"


def test_model_response_metadata_survives_parallel_calls(report_dir, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import MagicMock

    from analysis_core.services import llm
    from analysis_core.steps._pool import iter_pool_completed

    response = SimpleNamespace(
        id="response-id",
        model="served-model-2026-01-01",
        _request_id="request-id",
        system_fingerprint="backend-version",
        usage=None,
        choices=[SimpleNamespace(message=SimpleNamespace(content="text", refusal=None), finish_reason="stop")],
    )
    monkeypatch.setattr(llm, "OpenAI", MagicMock())
    monkeypatch.setattr(llm, "_send_openai_chat_request", lambda *args: response)
    with AuditSession(report_dir, "analysis") as session:
        session.step("extraction", status="started")
        for _, future in iter_pool_completed(lambda _: llm.request_to_openai([], model="alias"), list(range(12)), 4):
            assert future.result()[0] == "text"
    calls = [json.loads(line) for line in (session.directory / "model_responses.jsonl").read_text().splitlines()]
    assert len(calls) == 12
    assert all(call["model"] == "served-model-2026-01-01" and call["step"] == "extraction" for call in calls)
    assert all(call["request_id"] == "request-id" for call in calls)
    assert AuditStore(report_dir).verify(session.run_id)["valid"]


def test_planning_has_no_side_effect_before_audit_lock(report_dir, tmp_path):
    source = tmp_path / "job.json"
    source.write_text(json.dumps({"input": "report", "question": "Q", "provider": "local"}))
    output = report_dir.parent
    orchestrator = PipelineOrchestrator.from_config(source, output_base_dir=output, input_base_dir=tmp_path / "inputs")
    assert orchestrator.get_plan()
    assert not (output / "job" / "hierarchical_status.json").exists()
    assert AuditStore(output / "job").list_records() == []


def test_invalid_old_json_is_preserved_without_blocking_repair(report_dir):
    target = report_dir / "hierarchical_result.json"
    target.write_text("broken json")
    with AuditSession(report_dir, "analysis") as session:
        target.write_text('{"overview":"repaired"}')
    record = AuditStore(report_dir).read(session.run_id)
    old = next(f for f in record["files"] if f["path"] == "before/hierarchical_result.json")
    assert old["parse_status"] == "invalid_json"
    assert record["status"] == "completed"
