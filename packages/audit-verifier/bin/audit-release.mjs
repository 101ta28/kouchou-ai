#!/usr/bin/env node
/** Local file operations only. Never uploads, registers keys, or starts a server. */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LIMITS, writeArchive } from "../src/archive.mjs";
import { SIGNATURE_TYPE, base64url, digest, pemBytes } from "../src/signature.mjs";
import { createTransfer, verifyArchive } from "../src/verify.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

async function readBounded(path, maximum) {
  const stat = await lstat(path);
  check(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum,
    "通常のファイルと対応範囲内のサイズが必要です。",
  );
  const data = await readFile(path);
  check(data.length <= maximum, "読み取り中にファイルが上限を超えました。");
  return data;
}

async function writeExclusive(destination, bytes) {
  const temporary = await mkdtemp(join(dirname(resolve(destination)), ".audit-writing-"));
  try {
    const path = join(temporary, "content");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    await link(path, destination); // Atomic publication, refuses an existing name.
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function signArchive(input, { privateKeyPath, passphrasePath, audience = "public" }) {
  const verified = await verifyArchive(input, { audience });
  check(verified.report.integrity !== "mismatch", "欠落・不一致のある資料には署名できません。");
  const transfer = await createTransfer(verified.archive, audience, verified.report.sourceRunId);
  const secret = await readBounded(privateKeyPath, 32768);
  const passphrase = passphrasePath ? await readBounded(passphrasePath, 4096) : undefined;
  let key;
  try {
    key = createPrivateKey({ key: secret, format: "pem", ...(passphrase ? { passphrase } : {}) });
  } catch {
    throw new Error("署名鍵を読み取れません。形式と暗号化鍵のパスフレーズを確認してください。");
  } finally {
    secret.fill(0);
    passphrase?.fill(0);
  }
  check(
    key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1",
    "署名鍵はECDSA P-256が必要です。",
  );
  const publicPem = createPublicKey(key).export({ format: "pem", type: "spki" });
  const header = base64url(
    json({ alg: "ES256", kid: `sha256:${await digest(pemBytes(publicPem))}`, typ: SIGNATURE_TYPE }),
  );
  const transferBytes = json(transfer);
  const signature = sign("sha256", Buffer.from(`${header}.${base64url(transferBytes)}`), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  const files = new Map();
  for (const name of verified.archive.entries.keys()) files.set(name, await verified.archive.read(name));
  files.set("transfer.json", transferBytes);
  files.set("signature.jws.json", json({ protected: header, signature: base64url(signature) }));
  const result = writeArchive(files);
  const checked = await verifyArchive(result, { audience, publicKeyPem: publicPem });
  check(
    checked.report.signature.status === "valid" && checked.report.transferIntegrity === "hashes_match",
    "生成した署名の検証に失敗しました。",
  );
  return { bytes: result, report: checked.report };
}

function htmlEscape(text) {
  return String(text).replace(
    /[&<>"']/gu,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

export async function collectPublic(paths, { output, viewerPath, publicKeyPem = null }) {
  check(paths.length > 0 && paths.length <= 100, "資料集は1〜100件で作成してください。");
  const destination = resolve(output);
  try {
    await lstat(destination);
    throw new Error("出力先が既に存在します。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = await mkdtemp(join(dirname(destination), ".audit-collection-"));
  try {
    const records = [];
    const seen = new Set();
    let total = 0;
    for (const path of paths) {
      const bytes = await readBounded(path, LIMITS.archive);
      total += bytes.length;
      check(total <= 256 * 1024 * 1024, "資料集の合計サイズは256 MiBまでです。");
      const { report, document } = await verifyArchive(bytes, { publicKeyPem });
      check(
        report.integrity === "hashes_match" &&
          !["invalid", "different_key"].includes(report.signature.status) &&
          report.transferIntegrity !== "mismatch",
        "検査に失敗した公開資料は資料集に含められません。",
      );
      check(
        !publicKeyPem || report.signature.status === "valid",
        "公開鍵を指定した資料集には、その鍵で署名を確認できる資料だけを含められます。",
      );
      check(!seen.has(report.archiveSha256), "同じ資料が重複しています。");
      seen.add(report.archiveSha256);
      const filename = `${report.archiveSha256}.zip`;
      await writeFile(join(temporary, filename), bytes, { flag: "wx", mode: 0o644 });
      records.push({
        file: filename,
        archiveSha256: report.archiveSha256,
        sourceRunId: report.sourceRunId,
        releaseId: report.releaseId,
        model: document.model,
        startedAt: document.started_at,
        signatureStatus: report.signature.status,
        keyId: report.signature.keyId,
      });
    }
    const viewer = await readBounded(viewerPath, 8 * 1024 * 1024);
    await writeFile(join(temporary, "audit-viewer.html"), viewer, { flag: "wx", mode: 0o644 });
    await writeFile(
      join(temporary, "catalog.json"),
      json({
        schema_version: 1,
        audience: "public",
        records,
        viewerSha256: await digest(viewer),
        notice: "This is a collection of supplied public records, not proof of complete execution history.",
      }),
      { flag: "wx", mode: 0o644 },
    );
    const rows = records
      .map(
        (record) =>
          `<tr><td>${htmlEscape(record.sourceRunId)}</td><td>${htmlEscape(record.model ?? "未記録・非公開")}</td><td>${htmlEscape(record.startedAt)}</td><td><a href="${record.file}" download>ZIPを保存</a><br><code>${record.archiveSha256}</code></td></tr>`,
      )
      .join("\n");
    const style =
      "body{font-family:system-ui,sans-serif;line-height:1.8;color:#1f2937;background:#f8fafc;max-width:1100px;margin:2rem auto;padding:0 1rem}h1{font-size:1.8rem}a{color:#0755a3}a:focus-visible{outline:3px solid #0755a3;outline-offset:3px}.table-wrap{overflow:auto;background:white;border:1px solid #cbd5e1;border-radius:6px}table{border-collapse:collapse;width:100%;min-width:700px}th,td{text-align:left;vertical-align:top;padding:1rem;border-bottom:1px solid #e2e8f0;overflow-wrap:anywhere;max-width:280px}th{background:#f1f5f9}code{font-size:.8rem;overflow-wrap:anywhere}p{max-width:850px}";
    const styleHash = createHash("sha256").update(style).digest("base64");
    const page = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'sha256-${styleHash}'; base-uri 'none'; form-action 'none'"><title>公開監査資料集</title><style>${style}</style></head><body><h1>公開監査資料集</h1><p>この資料集は、選択された公開資料の複製です。すべての実行履歴が含まれることや、現在も公開中であることは示しません。</p><p><a href="audit-viewer.html">独立した監査ビューアを開く</a> ／ <a href="catalog.json" download>資料一覧を保存</a></p><p>ZIPを保存し、ビューアで選択してください。署名の検証には、別経路で確認した公開鍵を使用します。ここに掲載したハッシュだけでは配布元の身元を確認できません。</p><div class="table-wrap"><table><thead><tr><th scope="col">実行ID</th><th scope="col">モデル</th><th scope="col">開始日時（記載値）</th><th scope="col">資料・SHA-256</th></tr></thead><tbody>${rows}</tbody></table></div></body></html>\n`;
    await writeFile(join(temporary, "index.html"), page, { flag: "wx", mode: 0o644 });
    // Create exclusively, publish the index last, and never overwrite other work.
    await mkdir(destination, { mode: 0o755 });
    const created = [];
    try {
      const names = (await readdir(temporary)).filter((name) => name !== "index.html").sort();
      for (const name of [...names, "index.html"]) {
        const target = join(destination, name);
        await link(join(temporary, name), target);
        created.push(target);
      }
    } catch (error) {
      for (const target of created) await rm(target).catch(() => {});
      await rmdir(destination).catch(() => {});
      throw error;
    }
    return { directory: destination, records: records.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  const paths = [];
  const values = new Set([
    "--private-key",
    "--passphrase-file",
    "--public-key",
    "--output",
    "--viewer",
    "--expected-sha256",
  ]);
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i];
    if (item === "--internal") {
      check(!options[item], "オプションが重複しています。");
      options[item] = true;
    } else if (values.has(item)) {
      check(
        !Object.hasOwn(options, item) && rest[i + 1] && !rest[i + 1].startsWith("--"),
        "オプションの値が必要です。",
      );
      options[item] = rest[++i];
    } else {
      check(!item.startsWith("--"), `不明なオプションです: ${item}`);
      paths.push(item);
    }
  }
  const audience = options["--internal"] ? "internal" : "public";
  const allowed = {
    verify: ["--internal", "--public-key", "--expected-sha256", "--output"],
    sign: ["--internal", "--private-key", "--passphrase-file", "--output"],
    collect: ["--public-key", "--output", "--viewer"],
  };
  if (allowed[command])
    check(
      Object.keys(options).every((name) => allowed[command].includes(name)),
      "このコマンドでは使えないオプションです。",
    );
  const publicKeyPem = options["--public-key"]
    ? (await readBounded(options["--public-key"], 8192)).toString("utf8")
    : null;
  if (command === "verify") {
    check(paths.length === 1, "verifyにはZIPを1つ指定してください。");
    const { report } = await verifyArchive(await readBounded(paths[0], LIMITS.archive), {
      audience,
      publicKeyPem,
      expectedArchiveSha256: options["--expected-sha256"] ?? "",
    });
    if (options["--output"]) await writeExclusive(options["--output"], json(report));
    else process.stdout.write(json(report));
    return report.integrity === "mismatch" ||
      report.transferIntegrity === "mismatch" ||
      report.externalDigest.status === "mismatch" ||
      ["invalid", "different_key"].includes(report.signature.status) ||
      (publicKeyPem && report.signature.status !== "valid")
      ? 1
      : 0;
  }
  if (command === "sign") {
    check(
      paths.length === 1 && options["--private-key"] && options["--output"],
      "signにはZIP、--private-key、--outputが必要です。",
    );
    const signed = await signArchive(await readBounded(paths[0], LIMITS.archive), {
      audience,
      privateKeyPath: options["--private-key"],
      passphrasePath: options["--passphrase-file"],
    });
    await writeExclusive(options["--output"], signed.bytes);
    process.stdout.write(
      json({
        output: options["--output"],
        archiveSha256: signed.report.archiveSha256,
        keyId: signed.report.signature.keyId,
      }),
    );
    return 0;
  }
  if (command === "collect") {
    check(
      audience === "public" && options["--output"] && options["--viewer"],
      "collectには公開ZIP、--output、--viewerが必要です。内部記録は配布できません。",
    );
    const result = await collectPublic(paths, {
      output: options["--output"],
      viewerPath: options["--viewer"],
      publicKeyPem,
    });
    process.stdout.write(json(result));
    return 0;
  }
  process.stderr.write(
    "使用法:\n  node audit-release.mjs verify <zip> [--public-key <pem>] [--internal] [--expected-sha256 <hash>] [--output <json>]\n  node audit-release.mjs sign <zip> --private-key <pem> --output <zip> [--passphrase-file <file>] [--internal]\n  node audit-release.mjs collect <zip>... --viewer <index.html> --output <new-directory> [--public-key <pem>]\n",
  );
  return command === "help" || command === "--help" ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      // Do not print crypto exception objects, key contents, or decrypted input.
      console.error(`Error: ${error.message}`);
      process.exitCode = 1;
    });
}
