"""Synthetic interoperability fixtures produced by the real Python exporter."""

import hashlib
import argparse
import json
import tempfile
import zipfile
from pathlib import Path

from analysis_core.public_audit import (
    LIMITATIONS,
    OMISSIONS,
    PublicDocument,
    export_public_audit,
)

parser = argparse.ArgumentParser()
parser.add_argument(
    "--output", type=Path, default=Path(__file__).resolve().parents[1] / "fixtures"
)
root = parser.parse_args().output
root.mkdir(exist_ok=True)
document = PublicDocument(
    source_run_id="20261117T000000000000Z-" + "a" * 32,
    kind="analysis",
    status="completed",
    started_at="2026-11-17T00:00:00+00:00",
    finished_at="2026-11-17T00:00:01+00:00",
    provider="openai",
    model="gpt-4o-mini",
    analysis_mode="hierarchical",
    software={
        "analysis_core_version": "0.1.0",
        "analysis_core_source_sha256": "b" * 64,
    },
    steps=[
        {
            "name": "extraction",
            "status": "completed",
            "model": "gpt-4o-mini",
            "parameters": {"limit": 1000, "workers": 2},
            "prompts": {"prompt": {"source": "builtin", "template_id": "extraction"}},
        },
        {
            "name": "hierarchical_clustering",
            "status": "completed",
            "parameters": {"cluster_nums": [5, 2], "seed": 42},
        },
    ],
    counts={
        "input_rows": {"minimum": 20, "maximum": 29},
        "extracted_arguments": {"minimum": 10, "maximum": 19},
        "linked_input_ids": {"minimum": 10, "maximum": 19},
        "unlinked_input_ids": {"minimum": 10, "maximum": 19},
    },
    changed_sections=[],
    comparison_available=False,
    omitted=list(OMISSIONS),
    limitations=list(LIMITATIONS),
).model_dump(mode="json")


def stable_zip(name, entries):
    with zipfile.ZipFile(root / name, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, payload in entries.items():
            info = zipfile.ZipInfo(filename, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, payload)


with tempfile.TemporaryDirectory() as directory:
    path = Path(directory) / "export.zip"
    export_public_audit(document, path)
    with zipfile.ZipFile(path) as archive:
        original = {name: archive.read(name) for name in archive.namelist()}
    stable_zip("public-valid.zip", original)
    (root / "public-document.json").write_bytes(original["audit.json"])
    (root / "public-manifest.json").write_bytes(original["manifest.json"])
    changed = json.loads(original["audit.json"])
    changed["steps"][0]["parameters"]["workers"] = 3
    stable_zip(
        "public-tampered.zip",
        {
            **original,
            "audit.json": json.dumps(
                changed, ensure_ascii=False, sort_keys=True, indent=2
            ).encode()
            + b"\n",
        },
    )
    stable_zip("public-missing.zip", {"manifest.json": original["manifest.json"]})
    document["source_run_id"] = "20261118T000000000000Z-" + "c" * 32
    document["started_at"] = "2026-11-18T00:00:00+00:00"
    document["finished_at"] = "2026-11-18T00:00:02+00:00"
    document["steps"][0]["parameters"]["workers"] = 3
    document["changed_sections"] = ["settings"]
    document["comparison_available"] = True
    export_public_audit(document, path)
    with zipfile.ZipFile(path) as archive:
        stable_zip(
            "public-second.zip",
            {name: archive.read(name) for name in archive.namelist()},
        )

internal_files = {
    "inputs/example.csv": "comment-id,comment-body\nexample-1,これは架空の監査テストデータです\n".encode(),
    "after/args.csv": "arg-id,argument\na1,架空の意見です\n".encode(),
    "after/embeddings.pkl": b"NOT A REAL PICKLE - MUST NEVER EXECUTE",
    "config.json": json.dumps(
        {"model": "gpt-4o-mini", "question": "架空のテスト"}, ensure_ascii=False
    ).encode(),
}
manifest = {
    "schema_version": 1,
    "run_id": "20261117T000000000000Z-" + "a" * 32,
    "report": "synthetic-example",
    "kind": "analysis",
    "status": "completed",
    "started_at": "2026-11-17T00:00:00+00:00",
    "finished_at": "2026-11-17T00:00:01+00:00",
    "parent_run_id": None,
    "steps": [],
    "files": [
        {
            "path": name,
            "bytes": len(data),
            **(
                {"sha256": hashlib.sha256(data).hexdigest()}
                if name.startswith("inputs/")
                else {}
            ),
        }
        for name, data in internal_files.items()
    ],
}
stable_zip(
    "internal-example.zip",
    {
        "manifest.json": json.dumps(manifest, ensure_ascii=False).encode(),
        **internal_files,
    },
)
(root / "README.md").write_text(
    "# 検証用の架空データ\n\nすべて架空の資料です。実際の政策分析や監査結果ではありません。\n\n- public-valid.zip: ファイルのハッシュ一致、署名なし\n- public-second.zip: 別の実行。workers が2から3へ変化\n- public-tampered.zip: audit.jsonを変更し、元のmanifest.jsonを保持。ハッシュ不一致\n- public-missing.zip: audit.json欠落\n- internal-example.zip: 入力1ファイルはハッシュ検査、残り3ファイルはサイズのみ検査\n\n公開資料は実際のPythonエクスポーターで生成し、ZIPの日時だけを固定しています。\n",
    encoding="utf-8",
)
