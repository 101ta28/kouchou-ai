import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { writeArchive } from "../../packages/audit-verifier/src/archive.mjs";
import { VERSION } from "../../packages/audit-verifier/src/verify.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const app = fileURLToPath(new URL("./", import.meta.url));
const output = resolve(process.argv[2] ?? join(app, "dist"));
const modules = ["archive", "schema", "signature", "verify"].map((name) => `packages/audit-verifier/src/${name}.mjs`);
const schemaPath = "packages/audit-verifier/formats/public-audit-v1.schema.json";
const sources = [
  ...modules,
  schemaPath,
  "apps/audit-viewer/src/viewer.mjs",
  "apps/audit-viewer/src/style.css",
  "apps/audit-viewer/src/index.html",
  "apps/audit-viewer/build.mjs",
  "packages/audit-verifier/fixtures/public-valid.zip",
  "packages/audit-verifier/fixtures/public-second.zip",
];
const sourceFiles = new Map(await Promise.all(sources.map(async (path) => [path, await readFile(join(root, path))])));
const sha256 = (data, encoding = "hex") => createHash("sha256").update(data).digest(encoding);
const buildId = sha256(
  Buffer.concat([...sourceFiles].flatMap(([path, bytes]) => [Buffer.from(`${path}\0`), bytes, Buffer.from("\0")])),
);
const schema = JSON.parse(sourceFiles.get(schemaPath));
// The explicitly listed, dependency-free modules have no dynamic imports.
// Flatten only their top-level ESM declarations so file:// needs no module fetch.
const flatten = (text) => text.replace(/^import\b[\s\S]*?;\n/gmu, "").replace(/^export /gmu, "");
const samples = await Promise.all(
  ["public-valid.zip", "public-second.zip"].map(async (name) => ({
    name: `架空サンプル-${name}`,
    base64: (await readFile(join(root, "packages/audit-verifier/fixtures", name))).toString("base64"),
  })),
);
const verifierSource = `const publicSchema = ${JSON.stringify(schema)};\n${modules.map((path) => flatten(sourceFiles.get(path).toString())).join("\n")}`;
const workerSource = `${verifierSource}\nself.onmessage = async ({data}) => { try { const {report, document, manifest} = await verifyArchive(new Uint8Array(data.buffer), data.options); self.postMessage({result: {report, document, manifest}, buffer: data.buffer}, [data.buffer]); } catch (error) { self.postMessage({error: error.message || "資料を検査できませんでした。"}); } };`;
new Script(workerSource);
const script = `"use strict";\n(() => {\n${verifierSource}\nconst VIEWER_BUILD = ${JSON.stringify(buildId)};\nconst SAMPLE_ARCHIVES = ${JSON.stringify(samples)};\n${flatten(sourceFiles.get("apps/audit-viewer/src/viewer.mjs").toString())}\nstartViewer({buildId: VIEWER_BUILD, samples: SAMPLE_ARCHIVES, workerSource: ${JSON.stringify(workerSource)}});\n})();\n`;
new Script(script); // Fail the build on duplicate declarations or unsupported bundling.
if (/<\/script/iu.test(script)) throw new Error("Script contains an HTML closing tag");
const style = sourceFiles.get("apps/audit-viewer/src/style.css").toString();
const csp = `default-src 'none'; script-src 'sha256-${sha256(script, "base64")}'; style-src 'sha256-${sha256(style, "base64")}'; worker-src blob:; connect-src 'none'; img-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const html = sourceFiles
  .get("apps/audit-viewer/src/index.html")
  .toString()
  .replace("__CSP__", csp)
  .replace("__STYLE__", () => style)
  .replace("__SCRIPT__", () => script);
await mkdir(output, { recursive: true });
await writeFile(join(output, "index.html"), html);
await writeFile(
  join(output, "build.json"),
  `${JSON.stringify({ version: VERSION, buildSha256: buildId, htmlSha256: sha256(html) }, null, 2)}\n`,
);
const distribution = new Map([
  ["index.html", Buffer.from(html)],
  ["build.json", await readFile(join(output, "build.json"))],
]);
for (const [path, bytes] of sourceFiles) distribution.set(path, bytes);
for (const path of [
  "LICENSE",
  "packages/audit-verifier/README.md",
  "packages/audit-verifier/FORMAT.md",
  "packages/audit-verifier/package.json",
  "packages/audit-verifier/bin/audit-release.mjs",
  "packages/audit-verifier/formats/transfer-v1.schema.json",
  "packages/audit-verifier/formats/signature-v1.schema.json",
  "packages/audit-verifier/tests/verify.test.mjs",
  "packages/audit-verifier/tests/release.test.mjs",
  "packages/audit-verifier/scripts/export-schema.py",
  "packages/audit-verifier/scripts/generate-fixtures.py",
  "packages/audit-verifier/fixtures/README.md",
  "apps/audit-viewer/build.mjs",
  "apps/audit-viewer/package.json",
  "apps/audit-viewer/README.md",
  "apps/audit-viewer/tests/browser.test.mjs",
  "apps/audit-viewer/tests/build.test.mjs",
  "docs/development/independent-audit.md",
]) {
  distribution.set(path, await readFile(join(root, path)));
}
distribution.set(
  "README.md",
  Buffer.from(
    "# 広聴AI 監査資料ビューア\n\nindex.html をブラウザで開いてください。インストールやネット接続は不要です。\n\n- [操作・第三者への受け渡し](docs/development/independent-audit.md)\n- [形式仕様](packages/audit-verifier/FORMAT.md)\n- [検証用の架空データ](packages/audit-verifier/fixtures/README.md)\n- [ライセンス](LICENSE)\n\n同梱のソースを Node.js 22.17以降でビルドするには、展開先で `node apps/audit-viewer/build.mjs` を実行します。追加パッケージは不要です。\n",
  ),
);
for (const name of [
  "public-valid.zip",
  "public-second.zip",
  "public-tampered.zip",
  "public-missing.zip",
  "internal-example.zip",
  "public-document.json",
  "public-manifest.json",
]) {
  distribution.set(
    `packages/audit-verifier/fixtures/${name}`,
    await readFile(join(root, "packages/audit-verifier/fixtures", name)),
  );
}
await writeFile(join(output, "audit-viewer.zip"), writeArchive(distribution));
await writeFile(
  join(output, "SHA256SUMS"),
  `${sha256(html)}  index.html\n${sha256(await readFile(join(output, "audit-viewer.zip")))}  audit-viewer.zip\n`,
);
console.log(`Built offline viewer: ${join(output, "index.html")}\nBuild SHA-256: ${buildId}`);
