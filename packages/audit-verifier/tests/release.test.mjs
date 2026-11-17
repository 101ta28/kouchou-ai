import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectPublic, main, signArchive } from "../bin/audit-release.mjs";
import { parseJson, readArchive, writeArchive } from "../src/archive.mjs";
import { verifyArchive } from "../src/verify.mjs";

const fixturePath = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const fixture = (name) => readFile(fixturePath(name));
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "independent-audit-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPath = join(directory, "test-only-private.pem");
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  await writeFile(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return { directory, privateKeyPath, publicKeyPem };
}

test("signs without changing original evidence; independently verifies all received bytes", async (t) => {
  const key = await workspace(t);
  for (const [file, audience] of [
    ["public-valid.zip", "public"],
    ["internal-example.zip", "internal"],
  ]) {
    const original = await fixture(file);
    const signed = await signArchive(original, { ...key, audience });
    const checked = await verifyArchive(signed.bytes, { audience, publicKeyPem: key.publicKeyPem });
    assert.equal(checked.report.signature.status, "valid");
    assert.equal(checked.report.transferIntegrity, "hashes_match");
    const before = readArchive(original);
    for (const path of before.entries.keys())
      assert.deepEqual(await before.read(path), await checked.archive.read(path));
    assert.equal(checked.report.integrity, audience === "internal" ? "partial" : "hashes_match");
    await assert.rejects(signArchive(signed.bytes, { ...key, audience }), /既に/u);
  }
});

test("same-size changes to previously unhashed internal files fail the transfer check", async (t) => {
  const key = await workspace(t);
  const signed = await signArchive(await fixture("internal-example.zip"), { ...key, audience: "internal" });
  const zip = readArchive(signed.bytes);
  const files = new Map();
  for (const name of zip.entries.keys()) files.set(name, new Uint8Array(await zip.read(name)));
  files.get("after/embeddings.pkl")[0] ^= 1;
  const { report } = await verifyArchive(writeArchive(files), { audience: "internal", publicKeyPem: key.publicKeyPem });
  assert.equal(report.integrity, "partial");
  assert.equal(report.signature.status, "valid");
  assert.equal(report.transferIntegrity, "mismatch");
  assert.equal(report.transferChecks.find((file) => file.path === "after/embeddings.pkl").status, "hash_mismatch");
});

test("does not sign mismatched originals and accepts encrypted PKCS8 keys", async (t) => {
  const key = await workspace(t);
  await assert.rejects(signArchive(await fixture("public-tampered.zip"), key), /不一致/u);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const passphrasePath = join(key.directory, "test-only-passphrase");
  await writeFile(passphrasePath, "synthetic-test-passphrase", { mode: 0o600 });
  await writeFile(
    key.privateKeyPath,
    privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "synthetic-test-passphrase" }),
  );
  assert.equal(
    (await signArchive(await fixture("public-valid.zip"), { ...key, passphrasePath })).report.signature.status,
    "valid",
  );
});

test("static collection copies only validated public archives byte-for-byte", async (t) => {
  const { directory } = await workspace(t);
  const viewerPath = join(directory, "viewer.html");
  await writeFile(viewerPath, "<!doctype html><title>synthetic viewer</title>");
  const output = join(directory, "collection");
  await collectPublic([fixturePath("public-valid.zip"), fixturePath("public-second.zip")], { output, viewerPath });
  const catalog = parseJson(await readFile(join(output, "catalog.json")));
  assert.equal(catalog.records.length, 2);
  assert.deepEqual(await readFile(join(output, catalog.records[0].file)), await fixture("public-valid.zip"));
  assert.match(await readFile(join(output, "index.html"), "utf8"), /audit-viewer.html/u);
  await assert.rejects(collectPublic([fixturePath("public-valid.zip")], { output, viewerPath }), /既に存在/u);
  for (const file of ["public-tampered.zip", "internal-example.zip"]) {
    const rejected = join(directory, `${file}-rejected`);
    await assert.rejects(collectPublic([fixturePath(file)], { output: rejected, viewerPath }));
    assert(!(await readdir(directory)).includes(`${file}-rejected`));
  }
});

test("a supplied trust key requires a matching signature; CLI never overwrites an output", async (t) => {
  const key = await workspace(t);
  const keyPath = join(key.directory, "public.pem");
  await writeFile(keyPath, key.publicKeyPem);
  const output = join(key.directory, "report.json");
  const input = new URL("../fixtures/public-valid.zip", import.meta.url).pathname;
  assert.equal(await main(["verify", input, "--public-key", keyPath, "--output", output]), 1);
  const original = await readFile(output);
  await assert.rejects(main(["verify", input, "--output", output]), { code: "EEXIST" });
  assert.deepEqual(await readFile(output), original);
  await assert.rejects(main(["verify", input, "--private-key", key.privateKeyPath]), /使えない/u);
});
