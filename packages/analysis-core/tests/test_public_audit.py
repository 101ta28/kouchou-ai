import hashlib
import json
import zipfile

import pytest
from pydantic import ValidationError

from analysis_core.audit import AuditError, AuditSession, AuditStore
from analysis_core.audit_cli import main
from analysis_core.public_audit import build_public_audit, document_bytes, document_digest, export_public_audit


def test_public_zip_bytes_do_not_depend_on_export_time(evidence, tmp_path, monkeypatch):
    store, run_id, _ = evidence
    document = build_public_audit(store, run_id)
    first, second = tmp_path / "first.zip", tmp_path / "second.zip"
    export_public_audit(document, first)
    monkeypatch.setattr(zipfile.time, "localtime", lambda *args: (2030, 4, 5, 6, 7, 8, 0, 0, 0))
    export_public_audit(document, second)
    assert first.read_bytes() == second.read_bytes()


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    monkeypatch.delenv("KOUCHOU_AUDIT_DIR", raising=False)
    report = tmp_path / "outputs" / "report"
    report.mkdir(parents=True)
    personal = "PRIVATE-山田花子-hanako@example.org"
    source = tmp_path / f"{personal}.csv"
    source.write_text("comment-id,comment-body\n" + "".join(f"person-{i},{personal}\n" for i in range(23)))
    config = {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "analysis_mode": "hierarchical",
        "question": personal,
        "intro": personal,
        "source_slug": personal,
        "extraction": {
            "prompt": personal,
            "model": personal,
            "limit": 1000,
            "workers": 2,
            "categories": {personal: personal},
            "properties": [personal],
            "new_option": personal,
        },
        "hierarchical_clustering": {"cluster_nums": [5, 2], "reuse_umap_model": personal},
        "custom-plugin-name-" + personal: {"prompt": personal},
    }
    with AuditSession(report, "analysis", config, source) as session:
        (report / "args.csv").write_text("arg-id,argument\n" + "".join(f"a{i},{personal}\n" for i in range(12)))
        (report / "relations.csv").write_text("arg-id,comment-id\n" + "".join(f"a{i},person-{i}\n" for i in range(12)))
        (report / "hierarchical_result.json").write_text(json.dumps({"overview": personal, "config": config}))
        session.step("extraction", status="completed", error=personal)
        session.step("unknown-" + personal, status="failed", error=personal)
        session.model_response("openai", {"model": personal, "_request_id": personal})
    return AuditStore(report), session.run_id, personal


def test_public_document_does_not_copy_free_text_identifiers_or_internal_hashes(evidence):
    store, run_id, personal = evidence
    private_bytes = store.file(run_id, "manifest.json").read_bytes()
    document = build_public_audit(store, run_id)
    encoded = document_bytes(document).decode()
    assert personal not in encoded
    assert "person-" not in encoded and "source_slug" not in encoded and "parent_run_id" not in encoded
    assert str(store.path) not in encoded
    for file in store.read(run_id)["files"]:
        if "sha256" in file:
            assert file["sha256"] not in encoded
    assert document["model"] == "gpt-4o-mini"
    step = document["steps"][0]
    assert step["model"] is None
    assert step["prompts"]["prompt"] == {"source": "custom_or_unknown", "template_id": None}
    assert step["parameters"] == {"limit": 1000, "workers": 2}
    assert document["counts"] == {
        "input_rows": {"minimum": 20, "maximum": 29},
        "extracted_arguments": {"minimum": 10, "maximum": 19},
        "linked_input_ids": {"minimum": 10, "maximum": 19},
        "unlinked_input_ids": {"minimum": 10, "maximum": 19},
    }
    assert store.file(run_id, "manifest.json").read_bytes() == private_bytes
    assert (
        personal
        in store.file(
            run_id, "inputs/" + next(path.name for path in (store.record_dir(run_id) / "inputs").iterdir())
        ).read_text()
    )
    assert build_public_audit(store, run_id) == document


def test_public_zip_contains_only_generated_document_and_its_own_hash(evidence, tmp_path):
    store, run_id, personal = evidence
    document = build_public_audit(store, run_id)
    archive_path = tmp_path / "public.zip"
    export_public_audit(document, archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        assert set(archive.namelist()) == {"manifest.json", "audit.json"}
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["files"][0]["sha256"] == hashlib.sha256(archive.read("audit.json")).hexdigest()
        assert manifest["files"][0]["sha256"] == document_digest(document)
        assert personal.encode() not in b"".join(archive.read(name) for name in archive.namelist())


def test_export_defaults_to_public_and_internal_is_explicit(evidence, tmp_path):
    store, run_id, personal = evidence
    for audience in ("public", "internal"):
        target = tmp_path / f"{audience}.zip"
        args = ["--report-dir", str(store.report_dir), "export", run_id, "--output", str(target)]
        if audience == "internal":
            args.extend(["--audience", "internal"])
        assert main(args) == 0
        with zipfile.ZipFile(target) as archive:
            raw = b"".join(archive.read(name) for name in archive.namelist())
            assert (personal.encode() in raw) == (audience == "internal")
    assert main(["--report-dir", str(store.report_dir), "preview", run_id]) == 0


@pytest.mark.parametrize(
    "mutate",
    [
        lambda document: document.update(secret="private"),
        lambda document: document.update(model="private@example.org"),
        lambda document: document["steps"][0]["parameters"].update(extra="private"),
        lambda document: document["counts"]["input_rows"].update(maximum=23),
        lambda document: document.update(limitations=["private@example.org"]),
    ],
)
def test_public_schema_rejects_unknown_or_unreviewed_fields(evidence, mutate):
    store, run_id, _ = evidence
    document = build_public_audit(store, run_id)
    mutate(document)
    with pytest.raises(ValidationError):
        document_bytes(document)


def test_missing_evidence_prevents_public_generation(evidence):
    store, run_id, _ = evidence
    store.file(run_id, "after/relations.csv").unlink()
    with pytest.raises(AuditError, match="verification"):
        build_public_audit(store, run_id)


def test_incomplete_run_cannot_be_published(evidence):
    store, run_id, _ = evidence
    store.file(run_id, "manifest.json").unlink()
    with pytest.raises(AuditError, match="final"):
        build_public_audit(store, run_id)


def test_failed_extraction_does_not_present_old_results_as_new_counts(evidence):
    store, _, _ = evidence
    with AuditSession(store.report_dir, "analysis", {"model": "gpt-4o-mini"}) as session:
        session.step("extraction", status="failed")
        session.success = False
    document = build_public_audit(store, session.run_id)
    assert document["status"] == "failed"
    assert all(value is None for value in document["counts"].values())


def test_edit_changes_are_described_without_publishing_text(evidence):
    store, _, personal = evidence
    with AuditSession(store.report_dir, "config_edit", {"model": "gpt-4o"}) as session:
        session.write_data("before/report_config.json", {"model": "gpt-4o-mini", "extraction": {"prompt": personal}})
        session.config["extraction"] = {"prompt": "different private prompt"}
    document = build_public_audit(store, session.run_id)
    assert document["changed_sections"] == ["model", "prompts"]
    assert document["comparison_available"]
    assert all(value is None for value in document["counts"].values())


def test_known_prompt_is_referenced_without_copying_its_text(evidence):
    from analysis_core.prompts import EXTRACTION_PROMPT

    store, _, _ = evidence
    with AuditSession(store.report_dir, "analysis", {"extraction": {"prompt": EXTRACTION_PROMPT}}) as session:
        pass
    document = build_public_audit(store, session.run_id)
    assert document["steps"][0]["prompts"]["prompt"] == {"source": "builtin", "template_id": "extraction"}
    assert EXTRACTION_PROMPT not in json.dumps(document, ensure_ascii=False)


def test_zero_and_small_counts_have_the_same_public_range(evidence, tmp_path):
    store, _, _ = evidence
    inputs = tmp_path / "small.csv"
    for count in (0, 1, 9):
        inputs.write_text("comment-id,comment-body\n" + "".join(f"{i},private\n" for i in range(count)))
        with AuditSession(store.report_dir, "analysis", input_path=inputs) as session:
            pass
        assert build_public_audit(store, session.run_id)["counts"]["input_rows"] == {"minimum": 0, "maximum": 9}
