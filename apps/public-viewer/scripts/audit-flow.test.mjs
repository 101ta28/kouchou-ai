/** Production viewer -> downloaded ZIP -> independent CLI and offline HTML. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { readArchive } from "../../../packages/audit-verifier/src/archive.mjs";
import { verifyArchive } from "../../../packages/audit-verifier/src/verify.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const viewer = join(root, "apps/public-viewer");
const next = join(root, "node_modules/next/dist/bin/next");
const bytes = await readFile(join(root, "packages/audit-verifier/fixtures/public-valid.zip"));
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
const result = JSON.parse(await readFile(join(viewer, "components/dev/viewer-fixture.json")));
result.visibility = "public";
const meta = { reporter: "監査資料の動作確認", message: "架空の検証用データです。", isDefault: false };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

test(
  "public report downloads are usable independently, in server and static deployments",
  { timeout: 600000 },
  async (t) => {
    const originalTsconfig = await readFile(join(viewer, "tsconfig.json"));
    t.after(() => writeFile(join(viewer, "tsconfig.json"), originalTsconfig));
    const temporary = await mkdtemp(join(tmpdir(), "audit-flow-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    let publication = "published";
    const api = createServer(async (req, res) => {
      const url = new URL(req.url, "http://fixture");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/reports")
        return res.end(
          JSON.stringify([
            {
              slug: "example",
              status: "ready",
              visibility: "public",
              title: "監査確認",
              description: "",
              isPubcom: false,
            },
          ]),
        );
      if (url.pathname === "/reports/example") return res.end(JSON.stringify(result));
      if (url.pathname === "/meta/metadata.json") return res.end(JSON.stringify(meta));
      if (url.pathname === "/reports/example/audit") {
        if (publication === "error") {
          res.statusCode = 503;
          return res.end("{}");
        }
        return res.end(
          JSON.stringify({
            total: publication === "published" ? 1 : 0,
            records: publication === "published" ? [row] : [],
          }),
        );
      }
      if (url.pathname === `/reports/example/audit/${row.run_id}/download` && publication === "published") {
        if (url.searchParams.get("release_id") !== row.release_id) {
          res.statusCode = 409;
          return res.end("{}");
        }
        res.setHeader("Content-Type", "application/zip");
        return res.end(bytes);
      }
      res.statusCode = 404;
      res.end("{}");
    });
    const apiUrl = await listen(api);
    t.after(() => close(api));
    const env = {
      ...process.env,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
      API_BASEPATH: apiUrl,
      NEXT_PUBLIC_API_BASEPATH: apiUrl,
      NEXT_PUBLIC_PUBLIC_API_KEY: "fixture",
      NEXT_PUBLIC_SITE_URL: "https://example.invalid",
      NEXT_PUBLIC_OUTPUT_MODE: "",
      NEXT_PUBLIC_STATIC_EXPORT_BASE_PATH: "",
      NEXT_PUBLIC_STATIC_SHELL: "",
      NEXT_PUBLIC_GA_MEASUREMENT_ID: "",
    };
    const run = (args, cwd = root, extraEnv = {}) =>
      exec(process.execPath, args, { cwd, env: { ...env, ...extraEnv }, timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
    await run(["node_modules/typescript/bin/tsc", "--project", "packages/report-schema/tsconfig.json"]);
    await run(["apps/public-viewer/scripts/prepare-audit-tools.mjs"]);
    // Exercise the same wrapper as the package build, including restoration on failure.
    await run(["scripts/with-renamed-files.mjs", process.execPath, next, "build", "--webpack"], viewer);
    console.log("Production report build completed");
    const reserved = createServer();
    const liveUrl = await listen(reserved);
    const port = reserved.address().port;
    await close(reserved);
    const app = spawn(process.execPath, [next, "start", "-p", String(port), "--hostname", "127.0.0.1"], {
      cwd: viewer,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    app.stdout.on("data", (data) => {
      logs += data;
    });
    app.stderr.on("data", (data) => {
      logs += data;
    });
    t.after(async () => {
      if (app.exitCode === null) {
        app.kill("SIGTERM");
        await once(app, "exit");
      }
    });
    for (let i = 0; ; i++) {
      if (
        await fetch(`${liveUrl}/audit-tools/guide.html`)
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      assert(i < 120 && app.exitCode === null, logs);
      await delay(250);
    }
    const browser = await chromium.launch({ headless: true, channel: "chromium" });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route("https://fonts.googleapis.com/**", (route) =>
      route.fulfill({ body: "", contentType: "text/css" }),
    );
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(error.message);
    });
    await page.goto(`${liveUrl}/example/`);
    const panel = page.getByRole("region", { name: "公開監査資料" });
    await expect(panel.getByRole("button", { name: "監査資料をダウンロード（ZIP）" })).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    if (process.env.AUDIT_SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.AUDIT_SCREENSHOT_DIR, "report-audit-desktop.png") });
    await panel.locator("summary").click();
    await expect(panel.getByText(row.archive_sha256)).toBeVisible();
    const downloadEvent = page.waitForEvent("download");
    await panel.getByRole("button", { name: "監査資料をダウンロード（ZIP）" }).click();
    const download = await downloadEvent;
    const downloadedPath = join(temporary, "public-audit.zip");
    await download.saveAs(downloadedPath);
    assert.deepEqual(await readFile(downloadedPath), bytes);
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.scrollIntoViewIfNeeded();
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      "Mobile page overflows horizontally",
    );
    if (process.env.AUDIT_SCREENSHOT_DIR)
      await page.screenshot({ path: join(process.env.AUDIT_SCREENSHOT_DIR, "report-audit-mobile.png") });
    publication = "withdrawn";
    await panel.getByRole("button", { name: "監査資料をダウンロード（ZIP）" }).click();
    await expect(panel.getByRole("alert")).toContainText("資料を取得できませんでした");
    await panel.getByRole("button", { name: "一覧を再取得" }).click();
    await expect(panel).toContainText("公開されている監査資料はありません。");
    publication = "error";
    await page.reload();
    await expect(panel.getByRole("alert")).toContainText("一覧を取得できませんでした");
    publication = "published";
    await panel.getByRole("button", { name: "一覧を再取得" }).click();
    await expect(panel.getByRole("button", { name: "監査資料をダウンロード（ZIP）" })).toBeVisible();
    await panel.getByRole("link", { name: "手元で確認する方法・検証ツール" }).click();
    await expect(page.getByRole("heading", { name: "監査資料を手元で確認する" })).toBeVisible();
    const toolkitEvent = page.waitForEvent("download");
    await page.getByRole("link", { name: "検証ツールをダウンロード（ZIP）", exact: true }).click();
    const toolkit = readArchive(await readFile(await (await toolkitEvent).path()));
    const extracted = join(temporary, "tools");
    for (const name of toolkit.entries.keys()) {
      const target = join(extracted, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, await toolkit.read(name));
    }
    const cli = await run(["packages/audit-verifier/bin/audit-release.mjs", "verify", downloadedPath], extracted);
    assert.equal(JSON.parse(cli.stdout).archiveSha256, row.archive_sha256);
    // The hosted copy must also work under its HTTP CSP (including the worker).
    await page.getByRole("link", { name: "ブラウザで検証ツールを開く", exact: true }).click();
    await page.locator("#primary-file").setInputFiles(downloadedPath);
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("ハッシュ一致 1件");
    const offline = await browser.newContext({ offline: true });
    const outgoing = [];
    offline.on("request", (request) => {
      if (/^https?:/u.test(request.url())) outgoing.push(request.url());
    });
    const localPage = await offline.newPage();
    await localPage.goto(pathToFileURL(join(extracted, "index.html")).href);
    await localPage.locator("#primary-file").setInputFiles(downloadedPath);
    await localPage.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(localPage.locator("#summary")).toContainText("ハッシュ一致 1件");
    assert.deepEqual(outgoing, []);
    await offline.close();
    console.log("Report download, hosted verifier, downloaded CLI and offline HTML verified");

    // Build a static site with a base path, then stop relying on the API entirely.
    const staticDir = ".tmp/audit-flow-static";
    const staticEnv = {
      NEXT_PUBLIC_OUTPUT_MODE: "export",
      NEXT_PUBLIC_STATIC_EXPORT_BASE_PATH: "/preview",
      STATIC_EXPORT_DIST_DIR: staticDir,
    };
    await run(["scripts/copy-image.mjs"], viewer, staticEnv);
    await run(["scripts/with-renamed-files.mjs", process.execPath, next, "build", "--webpack"], viewer, staticEnv);
    await run(["scripts/export-public-audits.mjs"], viewer, staticEnv);
    const staticRoot = join(viewer, staticDir);
    assert(
      (await readFile(join(staticRoot, "example/index.html"), "utf8")).includes("公開監査資料"),
      "Static report HTML is missing",
    );
    t.after(() => rm(staticRoot, { recursive: true, force: true }));
    const site = createServer(async (req, res) => {
      const path = decodeURIComponent(new URL(req.url, "http://fixture").pathname);
      if (!path.startsWith("/preview/")) {
        res.statusCode = 404;
        return res.end();
      }
      const relative = path.slice("/preview/".length);
      if (relative.split("/").includes("..")) {
        res.statusCode = 400;
        return res.end();
      }
      const file = join(staticRoot, relative, path.endsWith("/") ? "index.html" : "");
      try {
        res.setHeader(
          "Content-Type",
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".zip": "application/zip",
          }[extname(file)] || "application/octet-stream",
        );
        res.end(await readFile(file));
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    const siteUrl = await listen(site);
    t.after(() => close(site));
    await page.route(`${apiUrl}/**`, (route) => route.abort());
    const staticResponse = await page.goto(`${siteUrl}/preview/example/`);
    assert.equal(staticResponse.status(), 200, `Static report returned ${staticResponse.status()}`);
    assert((await staticResponse.text()).includes("公開監査資料"), "Static response is not the report");
    await expect(panel).toContainText("静的配布時点の資料");
    const staticDownload = page.waitForEvent("download");
    await panel.getByRole("button", { name: "監査資料をダウンロード（ZIP）" }).click();
    assert.deepEqual(await readFile(await (await staticDownload).path()), bytes);
    await panel.getByRole("link", { name: "手元で確認する方法・検証ツール" }).click();
    await expect(page.getByRole("heading", { name: "監査資料を手元で確認する" })).toBeVisible();
    assert.deepEqual(errors, []);
  },
);
