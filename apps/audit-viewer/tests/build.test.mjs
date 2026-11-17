import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readArchive } from "../../../packages/audit-verifier/src/archive.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha256 = (value, format = "hex") => createHash("sha256").update(value).digest(format);

test("distribution rebuilds byte-for-byte from its own source, without the main application", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "audit-build-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const first = join(temporary, "first");
  execFileSync(process.execPath, ["apps/audit-viewer/build.mjs", first], { cwd: root });
  const html = await readFile(join(first, "index.html"), "utf8");
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)[1];
  const style = /<style>([\s\S]*?)<\/style>/u.exec(html)[1];
  assert(html.includes(`script-src 'sha256-${sha256(script, "base64")}'`));
  assert(html.includes(`style-src 'sha256-${sha256(style, "base64")}'`));
  assert(html.includes("connect-src 'none'"));
  assert(!/<script[^>]+src=/iu.test(html));
  const bundle = await readFile(join(first, "audit-viewer.zip"));
  const archive = readArchive(bundle);
  const extracted = join(temporary, "independent-copy");
  for (const path of archive.entries.keys()) {
    const destination = join(extracted, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await archive.read(path));
  }
  for (const required of [
    "LICENSE",
    "README.md",
    "packages/audit-verifier/FORMAT.md",
    "packages/audit-verifier/bin/audit-release.mjs",
    "packages/audit-verifier/tests/verify.test.mjs",
  ]) {
    assert(archive.entries.has(required), required);
  }
  execFileSync(process.execPath, ["apps/audit-viewer/build.mjs"], { cwd: extracted });
  assert.deepEqual(await readFile(join(extracted, "apps/audit-viewer/dist/index.html")), Buffer.from(html));
  assert.deepEqual(await readFile(join(extracted, "apps/audit-viewer/dist/audit-viewer.zip")), bundle);
  const result = execFileSync(
    process.execPath,
    ["packages/audit-verifier/bin/audit-release.mjs", "verify", "packages/audit-verifier/fixtures/public-valid.zip"],
    { cwd: extracted },
  );
  assert.equal(JSON.parse(result).integrity, "hashes_match");
});
