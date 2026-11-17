import publicSchema from "../formats/public-audit-v1.schema.json" with { type: "json" };
import { LIMITS, parseJson, readArchive, requireCondition, safePath } from "./archive.mjs";
import { sameValue, validDate, validatePublic } from "./schema.mjs";
import { digest, verifySignature } from "./signature.mjs";

export const VERSION = "1.0.0";
export const RUN_ID = /^[0-9]{8}T[0-9]{12}Z-[a-f0-9]{32}$/u;
export const HASH = /^[a-f0-9]{64}$/u;
export const VERIFICATION_LIMITATIONS = Object.freeze([
  "検査の対象は読み込んだ資料です。未提出の記録や稼働環境との一致は確認していません。",
  "ハッシュ・署名の一致は、原文の正しさ、分類の公平性、実行モデルの重みを証明しません。",
  "署名の信頼は、別経路で確認した公開鍵とその管理に依存します。失効状況をオンラインで確認していません。",
  "記録の日時は記載値です。第三者タイムスタンプは検証していません。",
  "公開取り消しや最新版の有無は、オフラインでは確認できません。",
]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value, required, optional = []) {
  requireCondition(
    object(value) &&
      required.every((key) => Object.hasOwn(value, key)) &&
      Object.keys(value).every((key) => required.includes(key) || optional.includes(key)),
    "マニフェストの項目が不正です。",
  );
}

function checkManifest(manifest, audience) {
  requireCondition(object(manifest) && manifest.schema_version === 1, "対応していないマニフェストの版です。");
  if (audience === "public") {
    keys(manifest, ["schema_version", "audience", "policy_version", "source_run_id", "files", "notice"]);
    requireCondition(
      manifest.audience === "public" &&
        manifest.policy_version === "public-audit-v1" &&
        RUN_ID.test(manifest.source_run_id),
      "公開資料の種別・版・実行IDが不正です。",
    );
    requireCondition(
      manifest.notice === "Review required before sharing. This archive contains no proof of source-text fidelity.",
      "公開マニフェストに規定外の説明文があります。",
    );
    requireCondition(
      Array.isArray(manifest.files) && manifest.files.length === 1 && manifest.files[0]?.path === "audit.json",
      "公開資料のファイル構成が不正です。",
    );
  } else {
    requireCondition(
      manifest.audience === undefined &&
        RUN_ID.test(manifest.run_id) &&
        ["completed", "failed"].includes(manifest.status) &&
        validDate(manifest.started_at) &&
        validDate(manifest.finished_at),
      "完了・失敗として確定した内部記録が必要です。",
    );
    requireCondition(
      Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= LIMITS.entries - 2,
      "内部記録のファイル一覧が不正です。",
    );
  }
  const seen = new Set();
  for (const entry of manifest.files) {
    if (audience === "public") keys(entry, ["path", "bytes", "sha256"]);
    else keys(entry, ["path", "bytes"], ["sha256", "redacted", "sanitized", "parse_status"]);
    requireCondition(
      safePath(entry.path) &&
        !seen.has(entry.path) &&
        !["manifest.json", "transfer.json", "signature.jws.json"].includes(entry.path),
      "マニフェストのパスが不正または重複しています。",
    );
    seen.add(entry.path);
    requireCondition(
      Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= LIMITS.entry,
      "マニフェストのサイズが不正です。",
    );
    requireCondition(
      entry.sha256 === undefined || (typeof entry.sha256 === "string" && HASH.test(entry.sha256)),
      "マニフェストのハッシュが不正です。",
    );
  }
}

export async function verifyArchive(
  bytes,
  { audience = "public", publicKeyPem = null, expectedArchiveSha256 = "" } = {},
) {
  requireCondition(["public", "internal"].includes(audience), "監査モードが不正です。");
  requireCondition(
    expectedArchiveSha256 === "" || HASH.test(expectedArchiveSha256),
    "照合用SHA-256は小文字64桁で指定してください。",
  );
  const archive = readArchive(bytes);
  if (audience === "public") {
    requireCondition(
      [...archive.entries.keys()].every((name) =>
        ["audit.json", "manifest.json", "transfer.json", "signature.jws.json"].includes(name),
      ),
      "公開用のZIPではありません。内部記録は内部監査モードで開いてください。",
    );
  }
  const manifestBytes = await archive.read("manifest.json", LIMITS.json);
  const manifest = parseJson(manifestBytes);
  checkManifest(manifest, audience);
  const expected = new Set([
    "manifest.json",
    "transfer.json",
    "signature.jws.json",
    ...manifest.files.map((entry) => entry.path),
  ]);
  requireCondition(
    [...archive.entries.keys()].every((name) => expected.has(name)),
    "ZIPにマニフェスト未登録のファイルがあります。",
  );
  const checks = [];
  let document = null;
  let releaseId = null;
  for (const entry of manifest.files) {
    const listed = archive.entries.get(entry.path);
    if (!listed) {
      checks.push({ path: entry.path, status: "missing", expectedBytes: entry.bytes });
      continue;
    }
    const content = await archive.read(entry.path);
    const sha256 = entry.sha256 === undefined ? null : await digest(content);
    checks.push({
      path: entry.path,
      status:
        content.length !== entry.bytes
          ? "size_mismatch"
          : sha256 !== null && sha256 !== entry.sha256
            ? "hash_mismatch"
            : sha256 === null
              ? "size_only"
              : "hash_match",
      expectedBytes: entry.bytes,
      actualBytes: content.length,
      expectedSha256: entry.sha256 ?? null,
      actualSha256: sha256,
    });
    if (audience === "public") {
      document = parseJson(content);
      validatePublic(document, publicSchema);
      requireCondition(document.source_run_id === manifest.source_run_id, "資料とマニフェストの実行IDが一致しません。");
      releaseId = await digest(content);
    }
  }
  let transfer = null;
  let transferBytes = null;
  let transferIntegrity = "absent";
  const transferChecks = [];
  if (archive.entries.has("transfer.json")) {
    transferBytes = await archive.read("transfer.json", LIMITS.json);
    transfer = parseJson(transferBytes);
    keys(transfer, ["schema_version", "type", "audience", "source_run_id", "files"]);
    requireCondition(
      transfer.schema_version === 1 &&
        transfer.type === "kouchou-audit-transfer" &&
        transfer.audience === audience &&
        transfer.source_run_id === (audience === "public" ? manifest.source_run_id : manifest.run_id) &&
        Array.isArray(transfer.files),
      "受渡し用マニフェストの形式が不正です。",
    );
    const registered = new Set();
    const originalNames = new Set(["manifest.json", ...manifest.files.map((entry) => entry.path)]);
    for (const file of transfer.files) {
      keys(file, ["path", "bytes", "sha256"]);
      requireCondition(
        originalNames.has(file.path) &&
          !registered.has(file.path) &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes >= 0 &&
          file.bytes <= LIMITS.entry &&
          typeof file.sha256 === "string" &&
          HASH.test(file.sha256),
        "受渡し用マニフェストのファイル一覧が不正です。",
      );
      registered.add(file.path);
      let status = "missing";
      if (archive.entries.has(file.path)) {
        const content = await archive.read(file.path);
        status =
          content.length !== file.bytes
            ? "size_mismatch"
            : (await digest(content)) !== file.sha256
              ? "hash_mismatch"
              : "hash_match";
      }
      transferChecks.push({ path: file.path, status });
    }
    requireCondition(registered.size === originalNames.size, "受渡し用マニフェストに未登録の原本があります。");
    transferIntegrity = transferChecks.every((entry) => entry.status === "hash_match") ? "hashes_match" : "mismatch";
  }
  requireCondition(
    !archive.entries.has("signature.jws.json") || transferBytes !== null,
    "署名の対象となる受渡し用マニフェストがありません。",
  );
  const signature = await verifySignature(
    transferBytes,
    archive.entries.has("signature.jws.json") ? await archive.read("signature.jws.json", 32768) : null,
    publicKeyPem,
  );
  const archiveSha256 = await digest(bytes);
  const integrity = checks.some((check) => !["hash_match", "size_only"].includes(check.status))
    ? "mismatch"
    : checks.some((check) => check.status === "size_only")
      ? "partial"
      : "hashes_match";
  const report = {
    verifier: "@kouchou-ai/audit-verifier",
    version: VERSION,
    checkedAt: new Date().toISOString(),
    audience,
    sourceRunId: audience === "public" ? manifest.source_run_id : manifest.run_id,
    archiveSha256,
    manifestSha256: await digest(manifestBytes),
    releaseId,
    format: "valid",
    integrity,
    checks,
    signature,
    transferIntegrity,
    transferChecks,
    externalDigest: {
      status:
        expectedArchiveSha256 === "" ? "not_provided" : expectedArchiveSha256 === archiveSha256 ? "match" : "mismatch",
      expected: expectedArchiveSha256 || null,
    },
    limitations: [...VERIFICATION_LIMITATIONS],
  };
  return { report, document, manifest, archive };
}

export async function createTransfer(archive, audience, runId) {
  const files = [];
  for (const path of [...archive.entries.keys()].sort()) {
    requireCondition(
      !["transfer.json", "signature.jws.json"].includes(path),
      "既に受渡し用の情報があるZIPには追加できません。",
    );
    const bytes = await archive.read(path);
    files.push({ path, bytes: bytes.length, sha256: await digest(bytes) });
  }
  return { schema_version: 1, type: "kouchou-audit-transfer", audience, source_run_id: runId, files };
}

export function compareDocuments(left, right) {
  const differences = [];
  function walk(a, b, path) {
    if (sameValue(a, b)) return;
    if (object(a) && object(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
        walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else {
      differences.push({
        path,
        before: a === undefined ? null : a,
        after: b === undefined ? null : b,
        beforePresent: a !== undefined,
        afterPresent: b !== undefined,
      });
    }
  }
  // Match processing steps by their names rather than array positions.
  const comparable = (doc) => ({
    ...doc,
    steps: Object.fromEntries(doc.steps.map(({ name, ...step }) => [name, step])),
  });
  walk(comparable(left), comparable(right), "");
  return differences;
}
