import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { crc32, parseJson, readArchive, writeArchive } from "../src/archive.mjs";
import { SIGNATURE_TYPE, base64url, digest, pemBytes } from "../src/signature.mjs";
import { compareDocuments, createTransfer, verifyArchive } from "../src/verify.mjs";

const fixture = (name) => readFile(new URL(`../fixtures/${name}`, import.meta.url));
const encode = (value) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
async function filesOf(bytes) {
  const zip = readArchive(bytes);
  return new Map(await Promise.all([...zip.entries.keys()].map(async (name) => [name, await zip.read(name)])));
}

test("reads real Python deflate exports without the API or analysis engine", async () => {
  const { report, document } = await verifyArchive(await fixture("public-valid.zip"));
  assert.equal(report.integrity, "hashes_match");
  assert.equal(report.signature.status, "absent");
  assert.equal(report.releaseId, await digest(await fixture("public-document.json")));
  assert.equal(document.steps[0].parameters.workers, 2);
  assert.equal(report.checks.length, 1);
});

test("reports changed bytes and missing files as failures", async () => {
  for (const [name, status] of [
    ["public-tampered.zip", "hash_mismatch"],
    ["public-missing.zip", "missing"],
  ]) {
    const { report } = await verifyArchive(await fixture(name));
    assert.equal(report.integrity, "mismatch");
    assert.equal(report.checks[0].status, status);
  }
});

test("keeps internal evidence out of public mode; distinguishes size-only checks", async () => {
  const bytes = await fixture("internal-example.zip");
  await assert.rejects(verifyArchive(bytes), /公開用のZIPではありません/u);
  const { report } = await verifyArchive(bytes, { audience: "internal" });
  assert.equal(report.integrity, "partial");
  assert.equal(report.checks.filter((file) => file.status === "hash_match").length, 1);
  assert.equal(report.checks.filter((file) => file.status === "size_only").length, 3);
});

test("compares recorded settings, not array positions", async () => {
  const left = (await verifyArchive(await fixture("public-valid.zip"))).document;
  const right = (await verifyArchive(await fixture("public-second.zip"))).document;
  right.steps.reverse();
  const changes = compareDocuments(left, right);
  assert.deepEqual(
    changes.find((row) => row.path === "steps.extraction.parameters.workers"),
    {
      path: "steps.extraction.parameters.workers",
      before: 2,
      after: 3,
      beforePresent: true,
      afterPresent: true,
    },
  );
  assert(!changes.some((row) => row.path.includes("hierarchical_clustering")));
});

test("external digest is checked independently of the bundled manifest", async () => {
  const bytes = await fixture("public-valid.zip");
  assert.equal(
    (await verifyArchive(bytes, { expectedArchiveSha256: await digest(bytes) })).report.externalDigest.status,
    "match",
  );
  assert.equal(
    (await verifyArchive(bytes, { expectedArchiveSha256: "0".repeat(64) })).report.externalDigest.status,
    "mismatch",
  );
});

test("rejects private, malformed and wrong-curve keys even for unsigned artifacts", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  for (const publicKeyPem of [
    "",
    "not a key",
    privateKey.export({ format: "pem", type: "pkcs8" }),
    publicKey.export({ format: "pem", type: "spki" }),
  ]) {
    await assert.rejects(verifyArchive(await fixture("public-valid.zip"), { publicKeyPem }));
  }
});

test("ES256 detached JWS requires a separately supplied matching key", async () => {
  const files = await filesOf(await fixture("public-valid.zip"));
  const verified = await verifyArchive(await fixture("public-valid.zip"));
  files.set("transfer.json", encode(await createTransfer(verified.archive, "public", verified.report.sourceRunId)));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ format: "pem", type: "spki" });
  const protectedHeader = base64url(
    encode({ alg: "ES256", kid: `sha256:${await digest(pemBytes(pem))}`, typ: SIGNATURE_TYPE }),
  );
  const input = `${protectedHeader}.${base64url(files.get("transfer.json"))}`;
  const signature = base64url(sign("sha256", Buffer.from(input), { key: privateKey, dsaEncoding: "ieee-p1363" }));
  files.set("signature.jws.json", encode({ protected: protectedHeader, signature }));
  const bytes = writeArchive(files);
  assert.equal((await verifyArchive(bytes)).report.signature.status, "needs_key");
  const report = (await verifyArchive(bytes, { publicKeyPem: pem })).report;
  assert.equal(report.signature.status, "valid");
  assert.equal(report.signature.trustedTime, false);
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "pem",
    type: "spki",
  });
  assert.equal((await verifyArchive(bytes, { publicKeyPem: other })).report.signature.status, "different_key");
  const manifest = parseJson(files.get("manifest.json"));
  manifest.files[0].sha256 = "0".repeat(64);
  files.set("manifest.json", encode(manifest));
  const altered = (await verifyArchive(writeArchive(files), { publicKeyPem: pem })).report;
  assert.equal(altered.signature.status, "valid");
  assert.equal(altered.transferIntegrity, "mismatch");
  const transfer = parseJson(files.get("transfer.json"));
  transfer.files[0].sha256 = "0".repeat(64);
  files.set("transfer.json", encode(transfer));
  assert.equal((await verifyArchive(writeArchive(files), { publicKeyPem: pem })).report.signature.status, "invalid");
});

test("rejects undefined public fields, unsupported versions, unsafe numbers and dishonest count ranges", async () => {
  const mutations = [
    (doc) => {
      doc.comments = ["private text"];
    },
    (doc) => {
      doc.schema_version = 2;
    },
    (doc) => {
      doc.model = "custom-private-name";
    },
    (doc) => {
      doc.steps[0].parameters.endpoint = "https://example.test";
    },
    (doc) => {
      doc.counts.input_rows.maximum = 20;
    },
    (doc) => {
      doc.started_at = "2026-02-30T00:00:00+00:00";
    },
    (doc) => {
      doc.steps.push(doc.steps[0]);
    },
  ];
  for (const mutate of mutations) {
    const files = await filesOf(await fixture("public-valid.zip"));
    const doc = parseJson(files.get("audit.json"));
    mutate(doc);
    files.set("audit.json", encode(doc));
    await assert.rejects(verifyArchive(writeArchive(files)));
  }
});

test("JSON rejects duplicate keys, invalid unicode, prototype pollution, excessive nesting and trailing data", () => {
  for (const json of [
    '{"a":1,"a":2}',
    '{"__proto__":{}}',
    '"\\ud800"',
    "[1,]",
    "1 2",
    "[NaN]",
    "1e999",
    `${"[".repeat(50)}0${"]".repeat(50)}`,
  ]) {
    assert.throws(() => parseJson(encode(json)));
  }
  assert.deepEqual(parseJson(encode('{"日本語":"😀", "value":1.5, "escaped":"\\""}')), {
    日本語: "😀",
    value: 1.5,
    escaped: '"',
  });
});

test("ZIP rejects traversal, unlisted files, duplicate paths and inconsistent headers", async () => {
  assert.throws(() => writeArchive(new Map([["../escape", encode("x")]])));
  const files = await filesOf(await fixture("public-valid.zip"));
  files.set("unexpected.txt", encode("private"));
  await assert.rejects(verifyArchive(writeArchive(files)));
  const duplicate = writeArchive(
    new Map([
      ["a.json", encode("a")],
      ["b.json", encode("b")],
    ]),
  );
  for (let index = 0; index < duplicate.length - 6; index++) {
    if (new TextDecoder().decode(duplicate.subarray(index, index + 6)) === "b.json") duplicate[index] = 97;
  }
  assert.throws(() => readArchive(duplicate), /重複/u);
  const broken = writeArchive(new Map([["x", encode("x")]]));
  broken[18] = 2;
  assert.throws(() => readArchive(broken), /一致しません/u);
});

test("ZIP checks actual decompressed length, CRC and preflight resource limits", async () => {
  const bytes = new Uint8Array(await fixture("public-valid.zip"));
  const directory = new DataView(bytes.buffer).getUint32(bytes.length - 6, true);
  new DataView(bytes.buffer).setUint32(22, 1, true);
  new DataView(bytes.buffer).setUint32(directory + 24, 1, true);
  await assert.rejects(readArchive(bytes).read("audit.json"), /展開サイズ/u);
  const corrupted = writeArchive(new Map([["x", encode("x")]]));
  corrupted[31] = 121;
  await assert.rejects(readArchive(corrupted).read("x"), /整合性/u);
  const huge = writeArchive(new Map([["x", encode("x")]]));
  new DataView(huge.buffer).setUint32(32 + 24, 100 * 1024 * 1024, true);
  assert.throws(() => readArchive(huge), /上限/u);
  assert.equal(crc32(encode("123456789")), 0xcbf43926);
});
