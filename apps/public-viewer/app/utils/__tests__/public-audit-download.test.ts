/** @jest-environment node */
import { createHash } from "node:crypto";
import { type PublicAuditRecord, fetchPublicAuditZip } from "../public-audit";

const originalFetch = global.fetch;
const originalEnv = process.env;
const bytes = Buffer.from("downloaded bytes");
const row: PublicAuditRecord = {
  run_id: `20261117T000000000000Z-${"a".repeat(32)}`,
  release_id: "a".repeat(64),
  archive_sha256: createHash("sha256").update(bytes).digest("hex"),
  archive_bytes: bytes.length,
  started_at: "2026-11-17T00:00:00+00:00",
  finished_at: "2026-11-17T00:01:00+00:00",
  published_at: "2026-11-17T01:00:00+00:00",
  kind: "analysis",
  status: "completed",
};
beforeEach(() => {
  process.env = { ...originalEnv, API_BASEPATH: "https://example.org/api" };
});
afterEach(() => {
  global.fetch = originalFetch;
  process.env = originalEnv;
});

it("pins the release and checks the downloaded bytes before saving", async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response(bytes));
  const blob = await fetchPublicAuditZip("example", row, new AbortController().signal);
  expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  expect(global.fetch).toHaveBeenCalledWith(
    expect.stringContaining(`?release_id=${row.release_id}`),
    expect.objectContaining({ cache: "no-store", credentials: "omit" }),
  );
});

it.each([Buffer.alloc(bytes.length, 65), Buffer.alloc(bytes.length + 1), Buffer.alloc(bytes.length - 1)])(
  "rejects changed, oversized and incomplete data",
  async (data) => {
    global.fetch = jest.fn().mockResolvedValue(new Response(data));
    await expect(fetchPublicAuditZip("example", row, new AbortController().signal)).rejects.toThrow(/mismatch/);
  },
);

it("does not save an error response as an archive", async () => {
  global.fetch = jest.fn().mockResolvedValue(new Response("not published", { status: 404 }));
  await expect(fetchPublicAuditZip("example", row, new AbortController().signal)).rejects.toThrow("404");
});
