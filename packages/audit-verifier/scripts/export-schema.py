"""Export the versioned wire schema; the independent verifier never imports core."""

import json
import sys
from pathlib import Path

from analysis_core.public_audit import (
    BOOLEAN_OPTIONS,
    LIMITATIONS,
    NUMERIC_OPTIONS,
    OMISSIONS,
    PROMPT_KEYS,
    PUBLIC_MODELS,
    PublicDocument,
)

schema = PublicDocument.model_json_schema()
schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
schema["$id"] = "urn:kouchou-ai:audit:public-audit-v1"
schema["description"] = (
    "Public export v1. Additional semantic constraints are documented in FORMAT.md."
)
schema["required"] = list(schema["properties"])
for definition in schema["$defs"].values():
    if definition.get("type") == "object":
        definition["required"] = list(definition.get("properties", {}))
model = {"anyOf": [{"type": "string", "enum": sorted(PUBLIC_MODELS)}, {"type": "null"}]}
schema["properties"]["model"] = model
step = schema["$defs"]["PublicStep"]["properties"]
step["model"] = model
step["parameters"] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        **{
            name: {
                "anyOf": [
                    {"type": "number", "minimum": 0, "maximum": 1_000_000_000},
                    {"type": "null"},
                ]
            }
            for name in NUMERIC_OPTIONS
        },
        **{name: {"type": "boolean"} for name in BOOLEAN_OPTIONS},
        "cluster_nums": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "integer", "minimum": 1, "maximum": 1_000_000},
        },
    },
}
step["prompts"] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {key: {"$ref": "#/$defs/PublicPrompt"} for key in PROMPT_KEYS},
}
schema["properties"]["omitted"] = {"const": list(OMISSIONS)}
schema["properties"]["limitations"] = {"const": list(LIMITATIONS)}
schema["properties"]["steps"]["maxItems"] = 12
schema["properties"]["changed_sections"]["uniqueItems"] = True
schema["$defs"]["CountRange"]["properties"]["minimum"]["multipleOf"] = 10
software = schema["$defs"]["PublicSoftware"]["properties"]
for name, pattern in {
    "analysis_core_version": r"^[0-9]+\.[0-9]+\.[0-9]+(?:(?:a|b|rc)[0-9]+)?$",
    "analysis_core_source_sha256": r"^[a-f0-9]{64}$",
    "git_commit": r"^(?:[a-f0-9]{40}|[a-f0-9]{64})$",
}.items():
    software[name] = {
        "anyOf": [{"type": "string", "pattern": pattern}, {"type": "null"}]
    }
for name in ("started_at", "finished_at"):
    schema["properties"][name]["format"] = "date-time"

destination = (
    Path(__file__).resolve().parents[1] / "formats/public-audit-v1.schema.json"
)
destination.parent.mkdir(parents=True, exist_ok=True)
if "--check" in sys.argv:
    if json.loads(destination.read_text(encoding="utf-8")) != schema:
        raise SystemExit(
            "Public audit schema has changed. Review the public format and regenerate its schema."
        )
else:
    destination.write_text(
        json.dumps(schema, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
