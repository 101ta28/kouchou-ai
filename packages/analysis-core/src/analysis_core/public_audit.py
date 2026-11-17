"""Allowlisted audit summaries. Never export raw evidence through this module.

The policy deliberately omits user-authored text, including custom model aliases
and prompts. Counts are report-wide ranges, not individual or subgroup records.
Human review is still required before publication; this is not anonymisation.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from analysis_core.audit import AuditError, AuditStore

POLICY_VERSION = "public-audit-v1"
COUNT_BUCKET_SIZE = 10
# A release policy, not a model discovery mechanism. Unrecognised identifiers
# stay internal even if they look like ordinary model names.
PUBLIC_MODELS = frozenset(
    {
        "gpt-4o-mini",
        "gpt-4o",
        "o3-mini",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gemini-2.5-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
        "openai/gpt-4o-2024-08-06",
        "openai/gpt-4o-mini-2024-07-18",
        "google/gemini-2.5-pro-preview",
        "text-embedding-3-small",
        "text-embedding-3-large",
        "gemini-embedding-001",
        "sentence-transformers/paraphrase-multilingual-mpnet-base-v2",
    }
)
STEPS = (
    "extraction",
    "embedding",
    "opinion_classification",
    "opinion_stance",
    "opinion_novelty",
    "hierarchical_clustering",
    "hierarchical_initial_labelling",
    "hierarchical_merge_labelling",
    "hierarchical_overview",
    "hierarchical_aggregation",
    "hierarchical_visualization",
    "llm_grouping",
)
STEP_ALIASES = {
    "clustering": "hierarchical_clustering",
    "initial_labelling": "hierarchical_initial_labelling",
    "merge_labelling": "hierarchical_merge_labelling",
    "overview": "hierarchical_overview",
    "aggregation": "hierarchical_aggregation",
    "visualization": "hierarchical_visualization",
}
NUMERIC_OPTIONS = (
    "limit",
    "workers",
    "timeout_seconds",
    "category_batch_size",
    "k",
    "seed",
    "sampling_num",
    "group_count",
    "discovery_sample_size",
    "assignment_batch_size",
    "n_neighbors",
    "n_components",
)
BOOLEAN_OPTIONS = ("enabled", "save_umap_model")
PROMPT_KEYS = ("prompt", "discovery_prompt", "assignment_prompt")
PROVIDERS = ("openai", "azure", "openrouter", "gemini", "local")
OMISSIONS = (
    "original_comments_and_identifiers",
    "generated_text_and_labels",
    "custom_prompts_and_model_aliases",
    "attributes_and_subgroup_statistics",
    "embeddings_and_binary_artifacts",
    "internal_paths_and_source_links",
    "credentials_endpoints_and_request_ids",
    "raw_errors_and_diagnostics",
    "internal_file_hashes",
    "exact_counts",
    "unrecognised_fields",
)
LIMITATIONS = (
    "Source-text fidelity and fairness require authorised access to internal evidence.",
    "Counts use fixed ranges of 10, including zero; no differential-privacy guarantee is made.",
    "Settings describe recorded selections, not proof of served model weights or deterministic reproduction.",
    "SHA-256 identifies this public document; it does not attest to the truth of the source evidence.",
)


class PublicSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class CountRange(PublicSchema):
    minimum: int = Field(ge=0)
    maximum: int = Field(ge=0)

    @field_validator("maximum")
    @classmethod
    def valid_range(cls, value, info):
        minimum = info.data.get("minimum", -1)
        if minimum % COUNT_BUCKET_SIZE or value != minimum + COUNT_BUCKET_SIZE - 1:
            raise ValueError("Invalid count range")
        return value


class PublicCounts(PublicSchema):
    input_rows: CountRange | None = None
    extracted_arguments: CountRange | None = None
    linked_input_ids: CountRange | None = None
    unlinked_input_ids: CountRange | None = None


class PublicPrompt(PublicSchema):
    source: Literal["builtin", "custom_or_unknown", "not_recorded"]
    template_id: Literal[*STEPS, "llm_grouping_discovery", "llm_grouping_assignment"] | None = None


class PublicStep(PublicSchema):
    name: Literal[*STEPS]
    status: Literal["completed", "failed", "skipped", "started", "not_recorded"] = "not_recorded"
    model: str | None = None
    parameters: dict[str, int | float | bool | None | list[int]] = Field(default_factory=dict)
    prompts: dict[str, PublicPrompt] = Field(default_factory=dict)

    @field_validator("model")
    @classmethod
    def public_model_only(cls, value):
        if value is not None and value not in PUBLIC_MODELS:
            raise ValueError("Model identifier is not in the publication policy")
        return value

    @field_validator("parameters")
    @classmethod
    def allowlisted_parameters(cls, value):
        if _parameters(value) != value:
            raise ValueError("Non-public parameters")
        return value

    @field_validator("prompts")
    @classmethod
    def allowlisted_prompts(cls, value):
        if set(value) - set(PROMPT_KEYS):
            raise ValueError("Unknown prompt field")
        return value


class PublicSoftware(PublicSchema):
    analysis_core_version: str | None = None
    analysis_core_source_sha256: str | None = None
    git_commit: str | None = None
    git_dirty: bool | None = None

    @field_validator("analysis_core_version")
    @classmethod
    def version_only(cls, value):
        if value is not None and not re.fullmatch(r"\d+\.\d+\.\d+(?:(?:a|b|rc)\d+)?", value):
            raise ValueError("Invalid software version")
        return value

    @field_validator("analysis_core_source_sha256", "git_commit")
    @classmethod
    def code_hash_only(cls, value, info):
        pattern = (
            r"[a-f0-9]{64}" if info.field_name == "analysis_core_source_sha256" else r"(?:[a-f0-9]{40}|[a-f0-9]{64})"
        )
        if value is not None and not re.fullmatch(pattern, value):
            raise ValueError("Invalid source identifier")
        return value


class PublicDocument(PublicSchema):
    schema_version: Literal[1] = 1
    policy_version: Literal["public-audit-v1"] = POLICY_VERSION
    audience: Literal["public"] = "public"
    source_run_id: str = Field(pattern=r"^[0-9]{8}T[0-9]{12}Z-[a-f0-9]{32}$")
    kind: Literal[
        "analysis",
        "translation",
        "config_edit",
        "cluster_label_edit",
        "visibility_edit",
        "visualization_config_edit",
        "other",
    ]
    status: Literal["completed", "failed"]
    started_at: str
    finished_at: str
    provider: Literal[*PROVIDERS] | None = None
    model: str | None = None
    analysis_mode: Literal["hierarchical", "llm_grouping"] | None = None
    software: PublicSoftware
    steps: list[PublicStep]
    counts: PublicCounts
    changed_sections: list[Literal["model", "prompts", "settings", "results", "labels", "visibility", "visualization"]]
    comparison_available: bool
    omitted: list[Literal[*OMISSIONS]]
    limitations: list[str]

    _model_only = field_validator("model")(PublicStep.public_model_only.__func__)

    @field_validator("started_at", "finished_at")
    @classmethod
    def valid_timestamp(cls, value):
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None or parsed.isoformat() != value:
            raise ValueError("Invalid audit timestamp")
        return value

    @field_validator("limitations")
    @classmethod
    def fixed_limitations(cls, value):
        if value != list(LIMITATIONS):
            raise ValueError("Unexpected limitations text")
        return value


def _parameters(value: dict) -> dict:
    result = {}
    for key in NUMERIC_OPTIONS:
        number = value.get(key)
        if number is None and key in value:
            result[key] = None
        elif type(number) in (int, float) and 0 <= number <= 1_000_000_000:
            result[key] = number
    for key in BOOLEAN_OPTIONS:
        if type(value.get(key)) is bool:
            result[key] = value[key]
    numbers = value.get("cluster_nums")
    if (
        isinstance(numbers, list)
        and len(numbers) <= 20
        and all(type(n) is int and 1 <= n <= 1_000_000 for n in numbers)
    ):
        result["cluster_nums"] = numbers
    return result


def _range(count: int) -> CountRange:
    low = count // COUNT_BUCKET_SIZE * COUNT_BUCKET_SIZE
    return CountRange(minimum=low, maximum=low + COUNT_BUCKET_SIZE - 1)


def _snapshot_json(store: AuditStore, run_id: str, files: set[str], name: str) -> dict:
    if name not in files:
        return {}
    try:
        value = json.loads(store.file(run_id, name).read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        if name.startswith("before/"):
            return {}  # a repaired run can contain a malformed old result
        raise
    return value if isinstance(value, dict) else {}


def _csv_stats(store: AuditStore, run_id: str, files: set[str], name: str):
    if name not in files:
        return None
    with store.file(run_id, name).open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        ids = set() if "comment-id" in (reader.fieldnames or ()) else None
        count = 0
        for row in reader:
            count += 1
            if ids is not None and row.get("comment-id") is not None:
                ids.add(row["comment-id"])
        return count, ids


def _counts(store: AuditStore, run_id: str, files: set[str], record: dict) -> PublicCounts:
    # Edits/translation preserve old artifacts; do not label them as newly processed data.
    if record.get("kind") != "analysis":
        return PublicCounts()
    inputs = sorted(p for p in files if p.startswith("inputs/") and p.endswith(".csv"))
    inputs_stats = _csv_stats(store, run_id, files, inputs[0]) if len(inputs) == 1 else None
    counts = PublicCounts(input_rows=_range(inputs_stats[0]) if inputs_stats is not None else None)
    extraction_events = [event.get("status") for event in record.get("steps", []) if event.get("step") == "extraction"]
    if not extraction_events or extraction_events[-1] not in {"completed", "skipped"}:
        return counts  # failed extraction may leave artifacts from an earlier run
    args = _csv_stats(store, run_id, files, "after/args.csv")
    relations = _csv_stats(store, run_id, files, "after/relations.csv")
    counts.extracted_arguments = _range(args[0]) if args is not None else None
    if inputs_stats is not None and inputs_stats[1] is not None and relations is not None and relations[1] is not None:
        input_ids = inputs_stats[1]
        linked = relations[1] & input_ids
        counts.linked_input_ids = _range(len(linked))
        counts.unlinked_input_ids = _range(len(input_ids - linked))
    return counts


def _prompt_info(step: str, key: str, value) -> PublicPrompt:
    if not isinstance(value, str) or not value:
        return PublicPrompt(source="not_recorded")
    from analysis_core.prompts import get_default_prompt

    template = f"llm_grouping_{key.removesuffix('_prompt')}" if key != "prompt" else step
    if value == get_default_prompt(template):
        return PublicPrompt(source="builtin", template_id=template)
    return PublicPrompt(source="custom_or_unknown")


def _steps(config: dict, record: dict) -> list[PublicStep]:
    statuses = {}
    for event in record.get("steps", []):
        name = STEP_ALIASES.get(event.get("step"), event.get("step"))
        if event.get("status") in {"started", "completed", "failed", "skipped"}:
            statuses[name] = event["status"]
    result = []
    for name in STEPS:
        value = config.get(name)
        if not isinstance(value, dict) and name not in statuses:
            continue
        value = value if isinstance(value, dict) else {}
        model = value.get("model")
        result.append(
            PublicStep(
                name=name,
                status=statuses.get(name, "not_recorded"),
                model=model if isinstance(model, str) and model in PUBLIC_MODELS else None,
                parameters=_parameters(value),
                prompts={key: _prompt_info(name, key, value.get(key)) for key in PROMPT_KEYS if key in value},
            )
        )
    return result


def _changes(store, run_id, files, record, config):
    before = _snapshot_json(store, run_id, files, "before/report_config.json")
    if not before:
        before = _snapshot_json(store, run_id, files, "before/hierarchical_result.json").get("config") or {}
    changed = []
    if isinstance(before, dict) and before:
        if any(before.get(k) != config.get(k) for k in ("model", "provider")):
            changed.append("model")
        for section in STEPS:
            old, new = before.get(section), config.get(section)
            old, new = old if isinstance(old, dict) else {}, new if isinstance(new, dict) else {}
            if old.get("model") != new.get("model") and "model" not in changed:
                changed.append("model")
            if any(old.get(k) != new.get(k) for k in PROMPT_KEYS) and "prompts" not in changed:
                changed.append("prompts")
            if _parameters(old) != _parameters(new) and "settings" not in changed:
                changed.append("settings")
    for filename, label in (
        ("hierarchical_result.json", "results"),
        ("hierarchical_merge_labels.csv", "labels"),
        ("visualization_config.json", "visualization"),
    ):
        left, right = f"before/{filename}", f"after/{filename}"
        if left in files and right in files:
            if store.file(run_id, left).read_bytes() != store.file(run_id, right).read_bytes():
                changed.append(label)
    if "visibility_change.json" in files:
        visibility = _snapshot_json(store, run_id, files, "visibility_change.json")
        if "after" in visibility and visibility.get("before") != visibility["after"]:
            changed.append("visibility")
    return changed, bool(before or any(path.startswith("before/") for path in files))


def build_public_audit(store: AuditStore, run_id: str) -> dict:
    """Create a deterministic review candidate from a final, verified record."""
    record = store.read(run_id)
    if record.get("status") not in {"completed", "failed"}:
        raise AuditError("Public audit requires a final internal record")
    if not store.verify(run_id)["valid"]:
        raise AuditError("Internal audit evidence failed verification")
    files = {item["path"] for item in record["files"]}
    config = _snapshot_json(store, run_id, files, "final_config.json")
    software = record.get("software") or {}
    public_software = {}
    for key in PublicSoftware.model_fields:
        try:
            public_software[key] = getattr(PublicSoftware(**{key: software.get(key)}), key)
        except ValueError:
            public_software[key] = None
    changed, compared = _changes(store, run_id, files, record, config)
    kind = record.get("kind")
    if kind not in {
        "analysis",
        "translation",
        "config_edit",
        "cluster_label_edit",
        "visibility_edit",
        "visualization_config_edit",
    }:
        kind = "other"
    model, provider, mode = config.get("model"), config.get("provider"), config.get("analysis_mode")
    document = PublicDocument(
        source_run_id=run_id,
        kind=kind,
        status=record["status"],
        started_at=record["started_at"],
        finished_at=record["finished_at"],
        provider=provider if provider in PROVIDERS else None,
        model=model if isinstance(model, str) and model in PUBLIC_MODELS else None,
        analysis_mode=mode if mode in ("hierarchical", "llm_grouping") else None,
        software=PublicSoftware(**public_software),
        steps=_steps(config, record),
        counts=_counts(store, run_id, files, record),
        changed_sections=changed,
        comparison_available=compared,
        omitted=list(OMISSIONS),
        limitations=list(LIMITATIONS),
    )
    return document.model_dump(mode="json")


def document_bytes(document: dict) -> bytes:
    checked = PublicDocument.model_validate(document).model_dump(mode="json")
    return (json.dumps(checked, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode()


def document_digest(document: dict) -> str:
    return hashlib.sha256(document_bytes(document)).hexdigest()


def export_public_audit(document: dict, destination: Path) -> None:
    """Export exactly two generated JSON files; no original files or file names."""
    payload = document_bytes(document)
    manifest = {
        "schema_version": 1,
        "audience": "public",
        "policy_version": POLICY_VERSION,
        "source_run_id": document["source_run_id"],
        "files": [{"path": "audit.json", "sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}],
        "notice": "Review required before sharing. This archive contains no proof of source-text fidelity.",
    }
    # Fixed metadata and STORE make the entire ZIP reproducible across machines
    # and zlib versions. Public summaries are small; avoid packaging timestamps
    # changing the digest of an otherwise identical release.
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, content in (
            ("audit.json", payload),
            ("manifest.json", (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()),
        ):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100600 << 16
            archive.writestr(entry, content)
