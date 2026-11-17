import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyArchive } from "../../../packages/audit-verifier/src/verify.mjs";
import { exportPublicAudits } from "./export-public-audits.mjs";

const bytes = await readFile(new URL("../../../packages/audit-verifier/fixtures/public-valid.zip", import.meta.url));
const { report, document } = await verifyArchive(bytes);
const row = {
  run_id: report.sourceRunId,
  release_id: report.releaseId,
  archive_sha256: report.archiveSha256,
  archive_bytes: bytes.length,
  published_at: "2026-11-17T00:00:00+00:00",
  kind: document.kind,
  started_at: document.started_at,
  finished_at: document.finished_at,
  status: document.status,
};
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "audit-export-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "public-audits");
}

test("static export keeps exact bytes, verified identifiers and retrieval time", async (t) => {
  const destination = await setup(t);
  const requests = [];
  await exportPublicAudits({
    apiBase: "https://api.example/base/",
    slugs: ["example"],
    destination,
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return url.includes("/download?") ? new Response(bytes) : Response.json({ total: 1, records: [row] });
    },
  });
  const index = JSON.parse(await readFile(join(destination, "example/index.json")));
  assert.equal(index.total, 1);
  assert.equal(index.records[0].archive_sha256, report.archiveSha256);
  assert(Number.isFinite(Date.parse(index.exported_at)));
  assert.deepEqual(await readFile(join(destination, "example", `${row.run_id}-${row.release_id}.zip`)), bytes);
  assert(requests[1][0].endsWith(`/download?release_id=${row.release_id}`));
  assert(
    requests.every(
      ([url, options]) =>
        url.startsWith("https://api.example/base/reports/example/audit") && options.cache === "no-store",
    ),
  );
});

test("404 means no publications and a fresh export removes old withdrawn archives", async (t) => {
  const destination = await setup(t);
  await exportPublicAudits({
    apiBase: "https://api.example",
    slugs: ["example"],
    destination,
    fetchImpl: async (url) =>
      url.includes("/download?") ? new Response(bytes) : Response.json({ total: 1, records: [row] }),
  });
  await exportPublicAudits({
    apiBase: "https://api.example",
    slugs: ["example"],
    destination,
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(JSON.parse(await readFile(join(destination, "example/index.json"))).total, 0);
  assert.equal(await stat(join(destination, "example", `${row.run_id}-${row.release_id}.zip`)).catch(() => null), null);
});

for (const failure of ["503", "digest", "private", "changed", "pagination"]) {
  test(`failed ${failure} export is not presented as a successful empty package`, async (t) => {
    const destination = await setup(t);
    const internal = await readFile(
      new URL("../../../packages/audit-verifier/fixtures/internal-example.zip", import.meta.url),
    );
    await assert.rejects(
      exportPublicAudits({
        apiBase: "https://api.example",
        slugs: ["example"],
        destination,
        fetchImpl: async (url) => {
          if (failure === "503") return new Response(null, { status: 503 });
          if (failure === "pagination") return Response.json({ total: 1, records: [] });
          if (url.includes("/download?"))
            return failure === "changed"
              ? new Response(null, { status: 409 })
              : new Response(failure === "private" ? internal : bytes);
          return Response.json({
            total: 1,
            records: [{ ...row, archive_sha256: failure === "digest" ? "0".repeat(64) : row.archive_sha256 }],
          });
        },
      }),
    );
    assert.equal(await stat(destination).catch(() => null), null);
  });
}

test("does not overwrite an unrelated directory or follow an output symlink", async (t) => {
  const destination = await setup(t);
  await mkdir(destination);
  await writeFile(join(destination, "keep.txt"), "unrelated");
  const options = { apiBase: "https://api.example", slugs: [], destination };
  await assert.rejects(exportPublicAudits(options), /Refusing to replace/u);
  assert.equal(await readFile(join(destination, "keep.txt"), "utf8"), "unrelated");
  const linked = `${destination}-link`;
  await symlink(destination, linked);
  await assert.rejects(exportPublicAudits({ ...options, destination: linked }), /not a symlink/u);
});
