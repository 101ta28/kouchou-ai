"""Guard the exchange contract between Python exports and the independent viewer."""

import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VERIFIER = ROOT / "packages/audit-verifier"


def test_public_schema_matches_current_exporter():
    subprocess.run([sys.executable, str(VERIFIER / "scripts/export-schema.py"), "--check"], check=True, cwd=ROOT)


def test_current_exporter_matches_interoperability_artifacts(tmp_path):
    subprocess.run(
        [sys.executable, str(VERIFIER / "scripts/generate-fixtures.py"), "--output", str(tmp_path)],
        check=True,
        cwd=ROOT,
    )
    # Compare uncompressed bytes, independent of the installed zlib version.
    for generated in tmp_path.glob("*.zip"):
        with (
            zipfile.ZipFile(generated) as current,
            zipfile.ZipFile(VERIFIER / "fixtures" / generated.name) as reference,
        ):
            assert current.namelist() == reference.namelist()
            for name in current.namelist():
                assert current.read(name) == reference.read(name)
