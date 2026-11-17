import { parseJson, requireCondition } from "./archive.mjs";

export async function digest(bytes) {
  requireCondition(
    globalThis.crypto?.subtle,
    "暗号検証機能が使えません。ローカルファイルまたはHTTPSで開いてください。",
  );
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64url(value) {
  requireCondition(
    typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value) && value.length <= 16384,
    "署名のbase64urlが不正です。",
  );
  let bytes;
  try {
    bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
  } catch {
    requireCondition(false, "署名のbase64urlが不正です。");
  }
  requireCondition(base64url(bytes) === value, "署名のbase64urlが正規形式ではありません。");
  return bytes;
}

export function pemBytes(pem) {
  requireCondition(typeof pem === "string" && pem.length <= 8192, "公開鍵が大きすぎます。");
  const match = /^\s*-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----\s*$/u.exec(pem);
  requireCondition(match, "公開鍵はSPKI形式のPEMが必要です。秘密鍵は受け付けません。");
  const encoded = match[1].replace(/\s/gu, "");
  let decoded;
  try {
    decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  } catch {
    requireCondition(false, "公開鍵のbase64が不正です。");
  }
  requireCondition(
    base64url(decoded) === encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
    "公開鍵のbase64が不正です。",
  );
  return decoded;
}

export const SIGNATURE_TYPE = "application/vnd.kouchou.audit-transfer+jws";

export async function verifySignature(manifestBytes, signatureBytes, publicKeyPem) {
  let key = null;
  let selectedKeyId = null;
  if (publicKeyPem !== null && publicKeyPem !== undefined) {
    const spki = pemBytes(publicKeyPem);
    selectedKeyId = `sha256:${await digest(spki)}`;
    try {
      key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    } catch {
      requireCondition(false, "この公開鍵はECDSA P-256ではありません。");
    }
  }
  if (!signatureBytes) return { status: "absent", keyId: null, selectedKeyId, trustedTime: false };
  const signature = parseJson(signatureBytes, 32768);
  requireCondition(
    signature &&
      !Array.isArray(signature) &&
      typeof signature === "object" &&
      Object.keys(signature).sort().join(",") === "protected,signature",
    "JWSの形式が不正です。",
  );
  const header = parseJson(fromBase64url(signature.protected), 8192);
  requireCondition(
    header &&
      Object.keys(header).sort().join(",") === "alg,kid,typ" &&
      header.alg === "ES256" &&
      header.typ === SIGNATURE_TYPE &&
      /^sha256:[a-f0-9]{64}$/u.test(header.kid),
    "対応しない署名方式または署名ヘッダーです。",
  );
  const bytes = fromBase64url(signature.signature);
  requireCondition(bytes.length === 64, "ES256署名の長さが不正です。");
  if (!key) return { status: "needs_key", keyId: header.kid, trustedTime: false };
  if (selectedKeyId !== header.kid) {
    return { status: "different_key", keyId: header.kid, selectedKeyId, trustedTime: false };
  }
  const input = new TextEncoder().encode(`${signature.protected}.${base64url(manifestBytes)}`);
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, bytes, input);
  return { status: valid ? "valid" : "invalid", keyId: header.kid, selectedKeyId, trustedTime: false };
}
