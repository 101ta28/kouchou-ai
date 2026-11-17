import { getApiBaseUrl } from "./api";
import { getRelativeUrl } from "./image-src";
import { isStaticExportBuild } from "./static-build";

export type PublicAuditRecord = {
  run_id: string;
  release_id: string;
  published_at: string;
  kind: string;
  started_at: string;
  finished_at: string;
  status: "completed" | "failed";
  archive_sha256: string;
  archive_bytes: number;
};
export type PublicAuditPage = { total: number; records: PublicAuditRecord[]; exported_at?: string };

const hash = /^[a-f0-9]{64}$/;
const runId = /^\d{8}T\d{12}Z-[a-f0-9]{32}$/;
const kinds = new Set([
  "analysis",
  "translation",
  "config_edit",
  "cluster_label_edit",
  "visibility_edit",
  "visualization_config_edit",
  "other",
]);
export const AUDIT_PAGE_SIZE = 20;

export function parsePublicAuditPage(value: unknown): PublicAuditPage {
  const page = value as PublicAuditPage;
  if (
    !page ||
    !Number.isSafeInteger(page.total) ||
    page.total < 0 ||
    !Array.isArray(page.records) ||
    page.total < page.records.length ||
    (page.exported_at !== undefined && !Number.isFinite(Date.parse(page.exported_at)))
  ) {
    throw new Error("Invalid public audit list");
  }
  const seen = new Set<string>();
  for (const row of page.records) {
    if (
      !row ||
      !runId.test(row.run_id) ||
      !hash.test(row.release_id) ||
      !hash.test(row.archive_sha256) ||
      !Number.isSafeInteger(row.archive_bytes) ||
      row.archive_bytes < 1 ||
      row.archive_bytes > 8 * 1024 * 1024 ||
      !kinds.has(row.kind) ||
      !["completed", "failed"].includes(row.status) ||
      ![row.started_at, row.finished_at, row.published_at].every(
        (value) => typeof value === "string" && Number.isFinite(Date.parse(value)),
      ) ||
      seen.has(row.run_id)
    )
      throw new Error("Invalid public audit record");
    seen.add(row.run_id);
  }
  return page;
}

function auditBase(slug: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(slug)) throw new Error("Invalid report slug");
  return `${getApiBaseUrl().replace(/\/+$/, "")}/reports/${encodeURIComponent(slug)}/audit`;
}

export async function fetchPublicAudits(slug: string, offset: number, signal: AbortSignal): Promise<PublicAuditPage> {
  const url = isStaticExportBuild()
    ? getRelativeUrl(`/data/public-audits/${encodeURIComponent(slug)}/index.json`)
    : `${auditBase(slug)}?limit=${AUDIT_PAGE_SIZE}&offset=${offset}`;
  const response = await fetch(url, { cache: "no-store", signal, credentials: "omit" });
  if (response.status === 404) return { total: 0, records: [] };
  if (!response.ok) throw new Error(`Audit list: ${response.status}`);
  const page = parsePublicAuditPage(await response.json());
  return isStaticExportBuild() ? { ...page, records: page.records.slice(offset, offset + AUDIT_PAGE_SIZE) } : page;
}

export function auditFilename(row: PublicAuditRecord) {
  return `${row.run_id}-${row.release_id}.zip`;
}

export async function fetchPublicAuditZip(slug: string, row: PublicAuditRecord, signal: AbortSignal): Promise<Blob> {
  const url = isStaticExportBuild()
    ? getRelativeUrl(`/data/public-audits/${encodeURIComponent(slug)}/${auditFilename(row)}`)
    : `${auditBase(slug)}/${row.run_id}/download?release_id=${row.release_id}`;
  const response = await fetch(url, { cache: "no-store", signal, credentials: "omit" });
  if (!response.ok) throw new Error(`Audit download: ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing archive body");
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > row.archive_bytes) throw new Error("Archive size mismatch");
      chunks.push(new Uint8Array(value));
    }
  } finally {
    await reader.cancel();
  }
  if (size !== row.archive_bytes) throw new Error("Archive size mismatch");
  const blob = new Blob(chunks, { type: "application/zip" });
  // HTTP deployments may not have Web Crypto. The independent offline verifier
  // can still check the displayed digest; the download itself claims no check.
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== row.archive_sha256) throw new Error("Archive digest mismatch");
  }
  return blob;
}
