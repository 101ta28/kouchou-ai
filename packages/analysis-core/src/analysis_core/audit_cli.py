"""Inspect internal evidence and export internal records or public summaries."""

import argparse
import json
import sys
from pathlib import Path

from analysis_core.audit import AuditError, AuditStore
from analysis_core.public_audit import build_public_audit, document_digest, export_public_audit


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="広聴AIの内部監査記録と公開監査資料を参照・検証・取得する")
    parser.add_argument("--report-dir", type=Path, required=True)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    for command in ("show", "verify", "preview", "export"):
        sub = commands.add_parser(command)
        sub.add_argument("run_id")
        if command == "export":
            sub.add_argument("--output", type=Path, required=True)
            sub.add_argument(
                "--audience",
                choices=("public", "internal"),
                default="public",
                help="既定は公開候補。原文を含む完全版には internal を明示する",
            )
    args = parser.parse_args(argv)
    try:
        store = AuditStore(args.report_dir)
        if args.command == "list":
            result = [
                {key: record[key] for key in ("run_id", "kind", "status", "started_at", "finished_at")}
                for record in store.list_records()
            ]
        elif args.command == "show":
            result = store.read(args.run_id)
        elif args.command == "verify":
            result = store.verify(args.run_id)
        elif args.command == "preview":
            document = build_public_audit(store, args.run_id)
            result = {"document": document, "sha256": document_digest(document), "review_required": True}
        else:
            # Refuse to overwrite an existing export without an explicit new path.
            with args.output.open("xb"):
                pass
            args.output.chmod(0o600)
            try:
                if args.audience == "internal":
                    store.export(args.run_id, args.output)
                else:
                    export_public_audit(build_public_audit(store, args.run_id), args.output)
            except BaseException:
                args.output.unlink(missing_ok=True)
                raise
            result = {"output": str(args.output), "audience": args.audience}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if args.command == "verify" and not result["valid"] else 0
    except (AuditError, OSError, ValueError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
