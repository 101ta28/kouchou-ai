/** @jest-environment node */
import { fetchAuditPreview, fetchAuditRecords, publishReviewedAudit, withdrawAudit } from "./actions";

jest.mock("@/app/utils/api", () => ({
  getApiBaseUrl: () => "http://api.test",
}));
const mockFetch = jest.fn();
global.fetch = mockFetch;
const digest = "a".repeat(64);
const response = (data: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => data,
});
const reports = (visibility = "private", status = "ready") => response([{ slug: "example", visibility, status }]);
beforeEach(() => {
  mockFetch.mockReset();
  process.env.NEXT_PUBLIC_ADMIN_API_KEY = "admin-test";
});

it("loads private audit history without caching and with administrator authentication", async () => {
  mockFetch.mockResolvedValue(response({ total: 0, records: [] }));
  expect(await fetchAuditRecords("space name", 50)).toEqual({
    success: true,
    data: { total: 0, records: [] },
  });
  expect(mockFetch).toHaveBeenCalledWith(
    "http://api.test/admin/reports/space%20name/audit?limit=50&offset=50",
    expect.objectContaining({
      cache: "no-store",
      headers: expect.objectContaining({ "x-api-key": "admin-test" }),
    }),
  );
});

it("does not send any requests without explicit review", async () => {
  expect(await publishReviewedAudit("example", "run", digest, false, true)).toMatchObject({
    success: false,
    reviewRequired: true,
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

it("checks the reviewed digest before publishing the report, then publishes only that run", async () => {
  mockFetch
    .mockResolvedValueOnce(reports())
    .mockResolvedValueOnce(response({ sha256: digest }))
    .mockResolvedValueOnce(response({}))
    .mockResolvedValueOnce(response({}));
  expect(await publishReviewedAudit("example", "selected-run", digest, true, true)).toEqual({ success: true });
  expect(mockFetch.mock.calls.map(([url, options]) => [url, options.method || "GET"])).toEqual([
    ["http://api.test/admin/reports", "GET"],
    ["http://api.test/admin/reports/example/audit/selected-run/public-preview", "GET"],
    ["http://api.test/admin/reports/example/visibility", "PATCH"],
    ["http://api.test/admin/reports/example/audit/selected-run/publication", "PUT"],
  ]);
  expect(JSON.parse(mockFetch.mock.calls[3][1].body)).toEqual({
    sha256: digest,
    reviewed: true,
  });
});

it("does not expose a private report when the preview has changed", async () => {
  mockFetch
    .mockResolvedValueOnce(reports())
    .mockResolvedValueOnce(response({ sha256: "b".repeat(64) }))
    .mockResolvedValueOnce(reports());
  expect(await publishReviewedAudit("example", "run", digest, true, true)).toMatchObject({
    success: false,
    visibility: "private",
    reviewRequired: true,
    error: expect.stringContaining("確認し直して"),
  });
  expect(mockFetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

it("adds an audit to an already public report without editing its visibility", async () => {
  mockFetch
    .mockResolvedValueOnce(reports("public"))
    .mockResolvedValueOnce(response({ sha256: digest }))
    .mockResolvedValueOnce(response({}));
  expect(await publishReviewedAudit("example", "run", digest, true, false)).toEqual({ success: true });
  expect(mockFetch.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(false);
});

it("does not re-publish a report hidden by another administrator", async () => {
  mockFetch.mockResolvedValue(reports("unlisted"));
  expect(await publishReviewedAudit("example", "run", digest, true, false)).toMatchObject({
    success: false,
    visibility: "unlisted",
    error: expect.stringContaining("公開範囲が変更"),
  });
  expect(mockFetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
});

it("reports partial publication and can retry the audit without repeating the visibility edit", async () => {
  mockFetch
    .mockResolvedValueOnce(reports())
    .mockResolvedValueOnce(response({ sha256: digest }))
    .mockResolvedValueOnce(response({}))
    .mockResolvedValueOnce(response({}, 503))
    .mockResolvedValueOnce(reports("public"));
  expect(await publishReviewedAudit("example", "run", digest, true, true)).toMatchObject({
    success: false,
    visibility: "public",
    error: expect.stringContaining("レポートは公開済み"),
  });
  mockFetch.mockReset();
  mockFetch
    .mockResolvedValueOnce(reports("public"))
    .mockResolvedValueOnce(response({ sha256: digest }))
    .mockResolvedValueOnce(response({}));
  expect(await publishReviewedAudit("example", "run", digest, true, false)).toEqual({ success: true });
  expect(mockFetch.mock.calls.some(([, options]) => options.method === "PATCH")).toBe(false);
});

it("rechecks visibility even when a failed PATCH already saved public visibility", async () => {
  mockFetch
    .mockResolvedValueOnce(reports())
    .mockResolvedValueOnce(response({ sha256: digest }))
    .mockResolvedValueOnce(response({}, 500))
    .mockResolvedValueOnce(reports("public"));
  expect(await publishReviewedAudit("example", "run", digest, true, true)).toMatchObject({
    success: false,
    visibility: "public",
  });
  expect(mockFetch.mock.calls.some(([, options]) => options.method === "PUT")).toBe(false);
});

it("returns an unknown state when a request and the recovery read both fail", async () => {
  mockFetch.mockRejectedValue(new Error("offline"));
  expect(await publishReviewedAudit("example", "run", digest, true, true)).toMatchObject({
    success: false,
    visibility: null,
    error: expect.stringContaining("現在の公開範囲を確認できません"),
  });
});

it("explains an unverifiable preview and preserves a withdrawal failure", async () => {
  mockFetch.mockResolvedValue(response({}, 409));
  expect(await fetchAuditPreview("example", "run")).toMatchObject({
    success: false,
    error: expect.stringContaining("保存ファイルを検証できない"),
  });
  mockFetch.mockResolvedValue(response({}, 503));
  expect(await withdrawAudit("example", "run")).toMatchObject({
    success: false,
  });
});
