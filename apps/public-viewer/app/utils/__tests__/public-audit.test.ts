import {
  type PublicAuditRecord,
  fetchPublicAudits,
  parsePublicAuditPage,
  publicAuditDownloadFilename,
} from "../public-audit";

const originalFetch = global.fetch;
const originalEnv = process.env;
const row: PublicAuditRecord = {
  run_id: `20261117T000000000000Z-${"a".repeat(32)}`,
  release_id: "a".repeat(64),
  archive_sha256: "b".repeat(64),
  archive_bytes: 100,
  started_at: "2026-11-17T00:00:00+00:00",
  finished_at: "2026-11-17T00:01:00+00:00",
  published_at: "2026-11-17T01:00:00+00:00",
  kind: "analysis",
  status: "completed",
};
afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

it("preserves the API base path and uses anonymous uncached requests", async () => {
  process.env = { ...originalEnv, NEXT_PUBLIC_API_BASEPATH: "https://example.org/api/" };
  global.fetch = jest
    .fn()
    .mockResolvedValue({ ok: true, status: 200, json: async () => ({ total: 1, records: [row] }) });
  await fetchPublicAudits("report", 20, new AbortController().signal);
  expect(global.fetch).toHaveBeenCalledWith(
    "https://example.org/api/reports/report/audit?limit=20&offset=20",
    expect.objectContaining({ cache: "no-store", credentials: "omit" }),
  );
});

it("reads static snapshots below the configured base path, without contacting the API", async () => {
  process.env = { ...originalEnv, NEXT_PUBLIC_OUTPUT_MODE: "export", NEXT_PUBLIC_STATIC_EXPORT_BASE_PATH: "/site" };
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ total: 1, records: [row], exported_at: row.published_at }),
  });
  const page = await fetchPublicAudits("report", 0, new AbortController().signal);
  expect(global.fetch).toHaveBeenCalledWith("/site/data/public-audits/report/index.json", expect.anything());
  expect(page.exported_at).toBe(row.published_at);
});

it("treats 404 as unavailable publications but surfaces server failures", async () => {
  global.fetch = jest.fn().mockResolvedValueOnce({ status: 404 }).mockResolvedValueOnce({ status: 503, ok: false });
  await expect(fetchPublicAudits("report", 0, new AbortController().signal)).resolves.toEqual({
    total: 0,
    records: [],
  });
  await expect(fetchPublicAudits("report", 0, new AbortController().signal)).rejects.toThrow("503");
});

it.each([
  { ...row, run_id: "../../private" },
  { ...row, archive_bytes: 1000000000 },
  { ...row, release_id: "invalid" },
  { ...row, published_at: "invalid" },
  { ...row, kind: "private arbitrary text" },
])("rejects malformed release metadata", (record) => {
  expect(() => parsePublicAuditPage({ total: 1, records: [record] })).toThrow();
});

it("uses localized labels and the displayed execution time in download filenames", () => {
  const record = { ...row, kind: "translation", started_at: "2026-11-18T10:49:20" };
  expect(publicAuditDownloadFilename("監査テスト", record, "ja")).toBe(
    "公開監査資料_監査テスト_翻訳_2026-11-18_10-49-20.zip",
  );
  expect(publicAuditDownloadFilename("Test report", record, "en")).toBe(
    "Public audit materials_Test report_Translation_2026-11-18_10-49-20.zip",
  );
  expect(publicAuditDownloadFilename("테스트", record, "ko")).toBe(
    "공개 감사 자료_테스트_번역_2026-11-18_10-49-20.zip",
  );
});

it("keeps unusual report titles usable as filenames", () => {
  const record = { ...row, started_at: "2026-11-18T10:49:20" };
  expect(publicAuditDownloadFilename('  意見/調査: "2026"?\n.  ', record, "ja")).toBe(
    "公開監査資料_意見_調査_ _2026____分析_2026-11-18_10-49-20.zip",
  );
  expect(publicAuditDownloadFilename(" ", record, "ja")).toBe("公開監査資料_分析_2026-11-18_10-49-20.zip");
  expect(publicAuditDownloadFilename("📝".repeat(100), record, "ja")).toBe(
    `公開監査資料_${"📝".repeat(40)}_分析_2026-11-18_10-49-20.zip`,
  );
});
