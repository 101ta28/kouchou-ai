import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectPublic, signArchive } from "../../../packages/audit-verifier/bin/audit-release.mjs";
import { readArchive, writeArchive } from "../../../packages/audit-verifier/src/archive.mjs";

const { chromium, expect } = await import(process.env.AUDIT_PLAYWRIGHT_MODULE ?? "@playwright/test");
const viewer = new URL("../dist/index.html", import.meta.url).href;
const fixtures = new URL("../../../packages/audit-verifier/fixtures/", import.meta.url);
const fixture = (name) => fileURLToPath(new URL(name, fixtures));

test("standalone viewer in an offline browser", { timeout: 120000 }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.AUDIT_BROWSER_EXECUTABLE });
  t.after(() => browser.close());
  const directory = await mkdtemp(join(tmpdir(), "audit-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const context = await browser.newContext({ offline: true, viewport: { width: 1280, height: 900 } });
  const requests = [];
  context.on("request", (request) => {
    if (/^https?:/u.test(request.url())) requests.push(request.url());
  });
  const pageErrors = [];
  context.on("page", (page) => {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
  });
  async function open() {
    const page = await context.newPage();
    await page.goto(viewer);
    await expect(page.locator("h1")).toHaveText("分析の進め方を確認する");
    return page;
  }

  async function uploadDocument(page, edit) {
    const doc = JSON.parse(await readFile(fixture("public-document.json"), "utf8"));
    edit(doc);
    const bytes = Buffer.from(JSON.stringify(doc));
    const manifest = JSON.parse(await readFile(fixture("public-manifest.json"), "utf8"));
    manifest.files[0].bytes = bytes.length;
    manifest.files[0].sha256 = createHash("sha256").update(bytes).digest("hex");
    await page.locator("#primary-file").setInputFiles({
      name: "表示確認用の資料.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(
        writeArchive(
          new Map([
            ["audit.json", bytes],
            ["manifest.json", Buffer.from(JSON.stringify(manifest))],
          ]),
        ),
      ),
    });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
  }

  await t.test("analysis conditions and readable settings precede technical details", async () => {
    const page = await open();
    await expect(page.getByRole("radio", { name: "内部監査", exact: true })).toBeHidden();
    await page.locator("#primary-file").setInputFiles(fixture("public-valid.zip"));
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator(".overview-panel h2")).toHaveText("分析条件と実行環境");
    await expect(page.locator(".fact-grid")).toContainText("gpt-4o-mini");
    await expect(page.locator(".fact-grid")).toContainText("OpenAI");
    await expect(page.locator(".fact-grid")).toContainText("広聴AI 分析エンジン 0.1.0");
    await expect(page.locator(".parameter-grid").first()).toContainText("1,000件");
    await expect(page.locator(".step-description").first()).toContainText("元のコメントから");
    await expect(page.locator("#audit-form")).toBeHidden();
    await expect(page.locator("#summary table").first()).toBeHidden();
    await expect(page.locator(".environment-details table")).toBeHidden();
    await expect(page.locator(".step-identifiers table").first()).toBeHidden();
    assert(
      await page
        .locator(".overview-panel")
        .evaluate((node) =>
          Boolean(
            node.compareDocumentPosition(document.querySelector(".file-checks")) & Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
    );
    assert(
      (await page.locator(".fact-grid").boundingBox()).y < 900,
      "Analysis conditions are visible without scrolling past technical tables",
    );
    await page.locator(".step-heading").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".parameter-grid").first()).toBeHidden();
    await page.keyboard.press("Enter");
    await expect(page.locator(".parameter-grid").first()).toBeVisible();
    await page.close();
  });

  await t.test("skipped, failed, unfinished and missing records remain distinct", async () => {
    const page = await open();
    await uploadDocument(page, (doc) => {
      doc.status = "failed";
      doc.steps = ["extraction", "embedding", "opinion_classification", "opinion_stance", "opinion_novelty"].map(
        (name, index) => ({
          name,
          status: ["completed", "skipped", "failed", "started", "not_recorded"][index],
          model: null,
          parameters: {},
          prompts: {},
        }),
      );
    });
    await expect(page.locator(".record-heading .bad")).toHaveText("分析：失敗");
    await expect(page.locator(".step-failed .step-note")).toBeVisible();
    await expect(page.locator(".step-started")).toContainText("完了したかは確認できません");
    await expect(page.locator(".step-not_recorded .check-label")).toHaveText("記録なし");
    await expect(page.locator(".step-skipped .step-note")).toBeHidden();
    await page.locator(".step-skipped > details > summary").click();
    await expect(page.locator(".step-skipped .step-note")).toContainText("過去の結果を再利用した場合も含みます");
    await uploadDocument(page, (doc) => {
      doc.model = null;
      doc.provider = null;
      doc.steps = [];
      for (const key of Object.keys(doc.counts)) doc.counts[key] = null;
    });
    await expect(page.locator(".fact-grid .fact").first()).toContainText("未記録・非公開");
    await expect(page.locator(".process-panel")).toContainText("処理ごとの記録はありません");
    assert(!(await page.locator(".count-grid").innerText()).includes("0件"));
    await page.close();
  });

  await t.test("sample comparison, keyboard access, JSON download and print", async () => {
    const page = await open();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "本文へ移動" })).toBeFocused();
    await page.getByRole("button", { name: "サンプルで試す" }).click();
    await expect(page.locator("#results")).toBeVisible();
    await expect(page.locator("#comparison")).toContainText("steps.extraction.parameters.workers");
    await expect(page.locator("#sample-notice")).toBeVisible();
    await page.locator("#review-notes").fill("架空の資料で差分を確認しました。");
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "検査結果とメモを保存（JSON）" }).click();
    const download = await downloading;
    const report = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.equal(report.reports.length, 2);
    assert.equal(report.sample, true);
    assert.equal(report.reviewerNotes, "架空の資料で差分を確認しました。");
    assert.equal(report.reports[0].signature.status, "absent");
    assert.equal(report.viewerBuildSha256.length, 64);
    if (process.env.AUDIT_SCREENSHOT_DIR) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(process.env.AUDIT_SCREENSHOT_DIR, "audit-desktop.png"), fullPage: false });
      await page.locator("#summary").screenshot({ path: join(process.env.AUDIT_SCREENSHOT_DIR, "audit-results.png") });
    }
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("#audit-form")).toBeHidden();
    const pdf = await page.pdf({ format: "A4" });
    assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
    assert(pdf.length > 10000);
    await expect(page.locator("#notes-print")).toHaveText("架空の資料で差分を確認しました。");
    await page.close();
  });

  await t.test("file upload, tamper and missing evidence results", async () => {
    const page = await open();
    for (const [name, expected] of [
      ["public-valid.zip", "ハッシュ一致 1件"],
      ["public-tampered.zip", "不一致・欠落あり"],
      ["public-missing.zip", "不一致・欠落あり"],
    ]) {
      await page.locator("#primary-file").setInputFiles(fixture(name));
      await expect(page.locator("#results")).toBeHidden();
      await page.getByRole("button", { name: "内容を表示", exact: true }).click();
      await expect(page.locator("#summary")).toContainText(expected);
      if (name !== "public-valid.zip") await expect(page.locator("#warnings .notice.error")).toBeVisible();
    }
    await page.close();
  });

  await t.test("unsupported ZIP metadata shows recovery steps before technical details", async () => {
    const page = await open();
    const original = await readFile(fixture("public-valid.zip"));
    const end = original.length - 22;
    const directory = original.readUInt32LE(end + 16);
    const afterName = directory + 46 + original.readUInt16LE(directory + 28);
    // Valid ZIP metadata that our deliberately limited archive profile rejects.
    const variants = [];
    for (const [field, metadata] of [
      [30, Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0])], // Extended timestamp.
      [32, Buffer.from("An entry comment")],
    ]) {
      const bytes = Buffer.concat([original.subarray(0, afterName), metadata, original.subarray(afterName)]);
      bytes.writeUInt16LE(metadata.length, directory + field);
      bytes.writeUInt32LE(original.readUInt32LE(end + 12) + metadata.length, end + metadata.length + 12);
      variants.push(bytes);
    }
    const comment = Buffer.from("An archive comment");
    const commented = Buffer.concat([original, comment]);
    commented.writeUInt16LE(comment.length, end + 20);
    variants.push(commented);
    for (const buffer of variants) {
      await page.locator("#primary-file").setInputFiles({ name: "監査資料.zip", mimeType: "application/zip", buffer });
      await page.getByRole("button", { name: "内容を表示", exact: true }).click();
      const error = page.getByRole("alert");
      await expect(error.getByRole("heading")).toHaveText("このZIPファイルは読み込めませんでした");
      await expect(error).toContainText("資料の内容はまだ確認できていません");
      await expect(error.locator("li").first()).toContainText("レポートの「公開監査資料」");
      await expect(error.locator("li").last()).toContainText("保存したZIPをそのまま選んでください");
      await expect(error).toContainText("取得したままのZIPでも開けない場合");
      await expect(error.locator("details p")).toBeHidden();
      assert(!(await error.innerText()).includes("ZIP64"));
      await expect(page.locator("#results")).toBeHidden();
      await error.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(error.locator("details p")).toBeVisible();
      await expect(error.locator("details p")).toContainText("コメント");
    }
    await page.locator("#advanced-options > summary").click();
    await page.getByRole("radio", { name: "内部監査", exact: true }).check();
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#error li").first()).toContainText("管理画面から内部監査資料");
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.getByRole("radio", { name: "公開監査", exact: true }).check();
    await page.locator("#primary-file").setInputFiles(fixture("public-valid.zip"));
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#error")).toBeHidden();
    await expect(page.locator(".overview-panel")).toBeVisible();
    await page.close();
  });

  await t.test("internal records require explicit mode and never execute embedded text", async () => {
    const page = await open();
    await page.locator("#primary-file").setInputFiles(fixture("internal-example.zip"));
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#error")).toContainText("公開用のZIPではありません");
    await page.locator("#advanced-options > summary").click();
    await page.getByRole("radio", { name: "内部監査", exact: true }).check();
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("サイズのみ 3件");
    await page.locator("#internal-file").selectOption("inputs/example.csv");
    await page.getByRole("button", { name: "テキストを開く" }).click();
    await expect(page.getByLabel("選択したファイルの内容")).toContainText("架空の監査テストデータ");
    assert(!(await page.locator("#internal-file option").allTextContents()).some((name) => name.endsWith(".pkl")));
    const archive = readArchive(new Uint8Array(await readFile(fixture("internal-example.zip"))));
    const files = new Map();
    for (const name of archive.entries.keys()) files.set(name, await archive.read(name));
    const attack = new TextEncoder().encode('<img src="https://example.test/leak" onerror="window.injected=true">');
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
    manifest.files.find((file) => file.path === "config.json").bytes = attack.length;
    files.set("config.json", attack);
    files.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
    await page.locator("#primary-file").setInputFiles({
      name: "synthetic-xss.zip",
      mimeType: "application/zip",
      buffer: Buffer.from(writeArchive(files)),
    });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.locator("#internal-file").selectOption("config.json");
    await page.getByRole("button", { name: "テキストを開く" }).click();
    await expect(page.getByLabel("選択したファイルの内容")).toContainText("<img");
    assert.equal(await page.evaluate(() => window.injected), undefined);
    assert.equal(await page.locator("img").count(), 0);
    await page.locator("#input-title").click();
    await page.getByRole("button", { name: "読み込んだ資料を消去" }).click();
    await expect(page.locator("#results")).toBeHidden();
    await page.close();
  });

  await t.test("trusted-key signature validation and mismatch", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKeyPath = join(directory, "test-key.pem");
    await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const signed = await signArchive(new Uint8Array(await readFile(fixture("public-valid.zip"))), { privateKeyPath });
    const page = await open();
    await page
      .locator("#primary-file")
      .setInputFiles({ name: "signed-example.zip", mimeType: "application/zip", buffer: Buffer.from(signed.bytes) });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("公開鍵が未指定のため未検証");
    await page.locator("#input-title").click();
    await page.locator("#advanced-options > summary").click();
    await page.getByText("署名・別経路のハッシュを確認する", { exact: true }).click();
    await page.locator("#public-key").setInputFiles({
      name: "public.pem",
      mimeType: "text/plain",
      buffer: Buffer.from(publicKey.export({ format: "pem", type: "spki" })),
    });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("選択した公開鍵と署名が一致");
    await page.locator("#input-title").click();
    await page.locator("#expected-digest").fill("0".repeat(64));
    await expect(page.locator("#results")).toBeHidden();
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary .notice.error")).toBeVisible();
    await page.close();
  });

  await t.test("mobile wrapping, large text and no horizontal page overflow", async () => {
    const page = await open();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "サンプルで試す" }).click();
    await expect(page.locator("#results")).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.AUDIT_SCREENSHOT_DIR) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: join(process.env.AUDIT_SCREENSHOT_DIR, "audit-mobile.png"), fullPage: false });
    }
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "24px";
    });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
  });
  await t.test("a slow verification can be cancelled, timed out and retried", async () => {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker;
      window.holdVerification = true;
      window.workerTerminations = 0;
      window.Worker = class extends OriginalWorker {
        postMessage(...args) {
          if (!window.holdVerification) super.postMessage(...args);
        }
        terminate() {
          window.workerTerminations++;
          super.terminate();
        }
      };
    });
    await page.goto(viewer);
    await page.locator("#primary-file").setInputFiles(fixture("public-valid.zip"));
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await page.getByRole("button", { name: "読み込みを中止", exact: true }).click();
    await expect(page.locator("#error")).toContainText("検査を中止しました");
    assert.equal(await page.evaluate(() => window.workerTerminations), 1);
    await page.evaluate(() => {
      const original = window.setTimeout;
      window.restoreVerificationTimer = () => {
        window.setTimeout = original;
      };
      window.setTimeout = (callback, delay, ...args) => original(callback, delay === 120000 ? 20 : delay, ...args);
    });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#error")).toContainText("120秒を超えたため中止");
    assert.equal(await page.evaluate(() => window.workerTerminations), 2);
    await page.evaluate(() => {
      window.holdVerification = false;
      window.restoreVerificationTimer();
    });
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("ハッシュ一致 1件");
    await page.close();
  });
  await t.test("a third-party static collection works without an API or original directory", async () => {
    const output = join(directory, "third-party-collection");
    await collectPublic([fixture("public-valid.zip"), fixture("public-second.zip")], {
      output,
      viewerPath: fileURLToPath(viewer),
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(pathToFileURL(join(output, "index.html")).href);
    await expect(page.getByRole("heading", { name: "公開監査資料集" })).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const pending = page.waitForEvent("download");
    await page.getByRole("link", { name: "ZIPを保存", exact: true }).first().click();
    const download = await pending;
    assert.deepEqual(await readFile(await download.path()), await readFile(fixture("public-valid.zip")));
    await page.getByRole("link", { name: "独立した監査ビューアを開く" }).click();
    await page.locator("#primary-file").setInputFiles(await download.path());
    await page.getByRole("button", { name: "内容を表示", exact: true }).click();
    await expect(page.locator("#summary")).toContainText("ハッシュ一致 1件");
    await page.close();
  });
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(requests, []);
  await context.close();
});
