/** Copy only approved public archives, preserving their exact bytes for offline use. */
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyArchive } from "../../../packages/audit-verifier/src/verify.mjs";

const validSlug = /^[A-Za-z0-9_-]+$/u;
const validRun = /^\d{8}T\d{12}Z-[a-f0-9]{32}$/u;
const validHash = /^[a-f0-9]{64}$/u;
const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

async function limitedBytes(response, maximum) {
  check(response.ok && response.body, `Audit download failed: ${response.status}`);
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    check(size <= maximum, "Audit response exceeds the size limit");
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export async function exportPublicAudits({ apiBase, slugs, destination, fetchImpl = fetch }) {
  check(/^https?:\/\//u.test(apiBase), "An HTTP(S) API base URL is required to export audit materials");
  check(
    slugs.every((slug) => validSlug.test(slug)) && new Set(slugs).size === slugs.length,
    "Invalid or duplicate report slug",
  );
  const base = apiBase.replace(/\/+$/u, "");
  const target = resolve(destination);
  const marker = "kouchou-public-audit-snapshot-v1";
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    check(
      existing.isDirectory() && !existing.isSymbolicLink(),
      "Audit export must be a generated directory, not a symlink",
    );
    check(
      (await readFile(join(target, ".snapshot-format"), "utf8").catch(() => "")) === marker,
      "Refusing to replace a directory not created by the public audit exporter",
    );
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = await mkdtemp(join(dirname(target), ".public-audits-"));
  let totalBytes = 0;
  try {
    for (const slug of slugs) {
      const prefix = `${base}/reports/${encodeURIComponent(slug)}/audit`;
      const records = [];
      let offset = 0;
      let total = null;
      while (total === null || offset < total) {
        const response = await fetchImpl(`${prefix}?limit=200&offset=${offset}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(30000),
        });
        // Older APIs and non-public reports have no public audit endpoint.
        if (response.status === 404 && offset === 0) break;
        const page = JSON.parse((await limitedBytes(response, 4 * 1024 * 1024)).toString("utf8"));
        check(
          Number.isSafeInteger(page.total) && page.total >= 0 && page.total <= 10000 && Array.isArray(page.records),
          "Invalid audit list",
        );
        check(total === null || total === page.total, "Audit publications changed during export; retry");
        total = page.total;
        check(page.records.length <= 200 && offset + page.records.length <= total, "Invalid audit pagination");
        check(page.records.length > 0 || offset === total, "Incomplete audit list");
        for (const row of page.records) {
          check(
            validRun.test(row.run_id) &&
              validHash.test(row.release_id) &&
              validHash.test(row.archive_sha256) &&
              Number.isSafeInteger(row.archive_bytes) &&
              row.archive_bytes > 0 &&
              row.archive_bytes <= 8 * 1024 * 1024 &&
              typeof row.published_at === "string" &&
              Number.isFinite(Date.parse(row.published_at)),
            "Invalid audit release metadata",
          );
          check(
            !records.some((other) => other.run_id === row.run_id),
            "Duplicate audit run; publications may have changed",
          );
          const downloaded = await fetchImpl(`${prefix}/${row.run_id}/download?release_id=${row.release_id}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(30000),
          });
          const bytes = await limitedBytes(downloaded, row.archive_bytes);
          totalBytes += bytes.length;
          check(totalBytes <= 256 * 1024 * 1024, "Audit export exceeds 256 MiB");
          const { report, document } = await verifyArchive(bytes);
          check(
            report.integrity === "hashes_match" &&
              report.sourceRunId === row.run_id &&
              report.releaseId === row.release_id &&
              report.archiveSha256 === row.archive_sha256 &&
              bytes.length === row.archive_bytes,
            "Downloaded audit does not match the selected release",
          );
          check(
            document.kind === row.kind &&
              document.started_at === row.started_at &&
              document.finished_at === row.finished_at &&
              document.status === row.status,
            "Audit list and document disagree",
          );
          const directory = join(temporary, slug);
          await mkdir(directory, { recursive: true });
          await writeFile(join(directory, `${row.run_id}-${row.release_id}.zip`), bytes, { flag: "wx" });
          records.push({
            run_id: row.run_id,
            release_id: row.release_id,
            published_at: row.published_at,
            archive_sha256: row.archive_sha256,
            archive_bytes: row.archive_bytes,
            kind: document.kind,
            started_at: document.started_at,
            finished_at: document.finished_at,
            status: document.status,
          });
        }
        offset += page.records.length;
      }
      const directory = join(temporary, slug);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "index.json"),
        JSON.stringify({ total: records.length, records, exported_at: new Date().toISOString() }, null, 2),
      );
    }
    await writeFile(join(temporary, ".snapshot-format"), marker);
    // Only replace this generated subtree. Never leave older withdrawn archives
    // in a new static export. A failed fetch/verification leaves no new package.
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const apiBase = process.env.API_BASEPATH || process.env.NEXT_PUBLIC_API_BASEPATH || "";
  const viewer = fileURLToPath(new URL("../", import.meta.url));
  const out = resolve(get("--site") || join(viewer, process.env.STATIC_EXPORT_DIST_DIR || "out"));
  const explicit = get("--slugs");
  let slugs;
  if (explicit !== undefined) {
    slugs = explicit.split(",").filter(Boolean);
  } else {
    const response = await fetch(`${apiBase.replace(/\/+$/u, "")}/reports`, {
      headers: { "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "" },
      signal: AbortSignal.timeout(30000),
      cache: "no-store",
    });
    check(response.ok, `Could not enumerate exported reports: ${response.status}`);
    const reports = await response.json();
    check(Array.isArray(reports), "Invalid reports response");
    slugs = [];
    for (const report of reports) {
      if (report.status !== "ready" || report.visibility === "private" || report.visibility === "unlisted") continue;
      check(validSlug.test(report.slug), "Invalid report slug");
      if (await stat(join(out, report.slug, "index.html")).catch(() => null)) slugs.push(report.slug);
    }
  }
  await exportPublicAudits({ apiBase, slugs, destination: get("--output") || join(out, "data/public-audits") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
