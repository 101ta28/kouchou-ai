/** A deliberately small ZIP profile: stored/deflate, UTF-8, no ZIP64 or encryption.
 * No entry is written to disk. Limits apply before and during decompression.
 */
export const LIMITS = Object.freeze({
  archive: 128 * 1024 * 1024,
  expanded: 256 * 1024 * 1024,
  entry: 64 * 1024 * 1024,
  entries: 4096,
  json: 4 * 1024 * 1024,
});

export class AuditFormatError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "AuditFormatError";
    this.code = code;
  }
}

export function requireCondition(condition, message, code) {
  if (!condition) throw new AuditFormatError(message, code);
}

export function safePath(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 512) return false;
  // Control characters and platform-specific separators are forbidden in ZIP paths.
  const invalid =
    /[\\:]/u.test(name) || [...String(name)].some((char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127);
  return !invalid && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function decode(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AuditFormatError("UTF-8として読み取れません。");
  }
}

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

export function readArchive(bytes) {
  requireCondition(bytes instanceof Uint8Array, "ZIPのバイト列が必要です。");
  requireCondition(
    bytes.length >= 22 && bytes.length <= LIMITS.archive,
    "ZIPのサイズが対応範囲外です（最大128 MiB）。",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at) => view.getUint16(at, true);
  const u32 = (at) => view.getUint32(at, true);
  // Our export profile has no archive comment, preamble, or trailing bytes.
  const end = bytes.length - 22;
  requireCondition(
    u32(end) === 0x06054b50 && u16(end + 20) === 0,
    "対応していないZIP形式です（末尾・コメント）。",
    "unsupported_zip_format",
  );
  const count = u16(end + 10);
  const size = u32(end + 12);
  const start = u32(end + 16);
  requireCondition(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count, "分割ZIPには対応していません。");
  requireCondition(
    count > 0 && count <= LIMITS.entries && start + size === end,
    "ZIPのファイル数または索引が不正です。",
  );
  const entries = new Map();
  let position = start;
  let total = 0;
  let previousEnd = 0;
  for (let i = 0; i < count; i++) {
    requireCondition(position + 46 <= end && u32(position) === 0x02014b50, "ZIPの索引が破損しています。");
    const flags = u16(position + 8);
    const method = u16(position + 10);
    const crc = u32(position + 16);
    const compressed = u32(position + 20);
    const length = u32(position + 24);
    const nameLength = u16(position + 28);
    const extraLength = u16(position + 30);
    const commentLength = u16(position + 32);
    const offset = u32(position + 42);
    const mode = (u32(position + 38) >>> 16) & 0xf000;
    requireCondition(
      (flags & ~0x800) === 0 && (method === 0 || method === 8),
      "暗号化・データ記述子・この圧縮方式には対応していません。",
    );
    requireCondition(
      extraLength === 0 && commentLength === 0 && u16(position + 34) === 0,
      "ZIP64・拡張フィールド・コメントには対応していません。",
      "unsupported_zip_format",
    );
    requireCondition(mode === 0 || mode === 0x8000, "通常のファイル以外は読み込めません。");
    requireCondition(position + 46 + nameLength <= end, "ZIPのファイル名が破損しています。");
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength);
    requireCondition(flags & 0x800 || nameBytes.every((byte) => byte < 128), "ファイル名はUTF-8が必要です。");
    const name = decode(nameBytes);
    requireCondition(safePath(name) && !entries.has(name), "ZIPに不正なパスまたは重複ファイルがあります。");
    total += length;
    requireCondition(
      length <= LIMITS.entry && total <= LIMITS.expanded,
      "展開後のサイズが上限を超えます（1ファイル64 MiB、合計256 MiB）。",
    );
    requireCondition(
      offset === previousEnd && offset + 30 <= start && u32(offset) === 0x04034b50,
      "ZIPのファイル配置が不正です。",
    );
    const localName = u16(offset + 26);
    const localExtra = u16(offset + 28);
    const dataStart = offset + 30 + localName;
    requireCondition(
      localExtra === 0 &&
        dataStart + compressed <= start &&
        localName === nameLength &&
        u16(offset + 6) === flags &&
        u16(offset + 8) === method &&
        u32(offset + 14) === crc &&
        u32(offset + 18) === compressed &&
        u32(offset + 22) === length &&
        decode(bytes.subarray(offset + 30, dataStart)) === name,
      "ZIPのヘッダーと索引が一致しません。",
    );
    requireCondition(method !== 0 || length === compressed, "非圧縮ファイルのサイズが不正です。");
    entries.set(name, { name, length, compressed, method, crc, dataStart });
    previousEnd = dataStart + compressed;
    position += 46 + nameLength;
  }
  requireCondition(position === end && previousEnd === start, "ZIPに未登録の領域があります。");

  async function read(name, maxBytes = LIMITS.entry) {
    const entry = entries.get(name);
    requireCondition(entry, `必要なファイルがありません: ${name}`);
    requireCondition(entry.length <= maxBytes, `ファイルが読み取り上限を超えています: ${name}`);
    const compressedBytes = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
    let output;
    if (entry.method === 0) {
      output = compressedBytes;
    } else {
      let stream;
      try {
        stream = new Blob([compressedBytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      } catch {
        throw new AuditFormatError("このブラウザはZIPの展開に対応していません。対応ブラウザをご利用ください。");
      }
      const reader = stream.getReader();
      const chunks = [];
      let actual = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          actual += value.length;
          requireCondition(actual <= entry.length && actual <= maxBytes, "ZIPの実際の展開サイズが上限を超えました。");
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof AuditFormatError) throw error;
        throw new AuditFormatError("ZIPの圧縮データが破損しています。");
      } finally {
        reader.releaseLock();
      }
      output = new Uint8Array(actual);
      let offset = 0;
      for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
      }
    }
    requireCondition(
      output.length === entry.length && crc32(output) === entry.crc,
      `ZIPの整合性が一致しません: ${name}`,
    );
    return output;
  }
  return { entries, read };
}

/** Reproducible stored ZIP used by the offline release tools; no host metadata. */
export function writeArchive(files) {
  requireCondition(files instanceof Map && files.size > 0 && files.size <= LIMITS.entries, "ファイル数が不正です。");
  let localLength = 0;
  let directoryLength = 0;
  const prepared = [];
  for (const [name, data] of files) {
    requireCondition(
      safePath(name) && data instanceof Uint8Array && data.length <= LIMITS.entry,
      "出力ファイルが不正です。",
    );
    const nameBytes = new TextEncoder().encode(name);
    prepared.push({ nameBytes, data, crc: crc32(data), offset: localLength });
    localLength += 30 + nameBytes.length + data.length;
    directoryLength += 46 + nameBytes.length;
  }
  requireCondition(localLength + directoryLength + 22 <= LIMITS.archive, "出力ZIPが128 MiBを超えます。");
  const result = new Uint8Array(localLength + directoryLength + 22);
  const view = new DataView(result.buffer);
  const put16 = (at, value) => view.setUint16(at, value, true);
  const put32 = (at, value) => view.setUint32(at, value, true);
  let directory = localLength;
  for (const { nameBytes, data, crc, offset } of prepared) {
    put32(offset, 0x04034b50);
    put16(offset + 4, 20);
    put16(offset + 6, 0x800);
    put16(offset + 12, 33);
    put32(offset + 14, crc);
    put32(offset + 18, data.length);
    put32(offset + 22, data.length);
    put16(offset + 26, nameBytes.length);
    result.set(nameBytes, offset + 30);
    result.set(data, offset + 30 + nameBytes.length);
    put32(directory, 0x02014b50);
    put16(directory + 4, 20);
    put16(directory + 6, 20);
    put16(directory + 8, 0x800);
    put16(directory + 14, 33);
    put32(directory + 16, crc);
    put32(directory + 20, data.length);
    put32(directory + 24, data.length);
    put16(directory + 28, nameBytes.length);
    put32(directory + 42, offset);
    result.set(nameBytes, directory + 46);
    directory += 46 + nameBytes.length;
  }
  put32(directory, 0x06054b50);
  put16(directory + 8, files.size);
  put16(directory + 10, files.size);
  put32(directory + 12, directoryLength);
  put32(directory + 16, localLength);
  return result;
}

/** Strict JSON, including duplicate-name rejection before JSON.parse can hide it. */
export function parseJson(bytes, maxBytes = LIMITS.json) {
  requireCondition(bytes.length <= maxBytes, "JSONのサイズが上限を超えています。");
  const text = decode(bytes);
  let at = 0;
  let nodes = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/u.test(text[at] ?? "x")) at++;
  };
  function string() {
    const start = at++;
    let escaped = false;
    while (at < text.length) {
      const c = text[at++];
      if (c === '"' && !escaped) {
        const value = JSON.parse(text.slice(start, at));
        requireCondition(!/[\ud800-\udfff]/u.test(value), "JSONに不正なUnicode文字があります。");
        return value;
      }
      escaped = c === "\\" && !escaped;
    }
    throw new AuditFormatError("JSONの文字列が閉じていません。");
  }
  function value(depth) {
    requireCondition(depth <= 48 && ++nodes <= 200000, "JSONの深さまたは項目数が上限を超えています。");
    whitespace();
    if (text[at] === '"') return string();
    if (text[at] === "{" || text[at] === "[") {
      const object = text[at++] === "{";
      const result = object ? {} : [];
      const close = object ? "}" : "]";
      const keys = new Set();
      whitespace();
      if (text[at] === close) {
        at++;
        return result;
      }
      while (at < text.length) {
        whitespace();
        let key;
        if (object) {
          requireCondition(text[at] === '"', "JSONのキーが不正です。");
          key = string();
          requireCondition(
            !keys.has(key) && !["__proto__", "prototype", "constructor"].includes(key),
            "JSONに重複キーまたは予約キーがあります。",
          );
          keys.add(key);
          whitespace();
          requireCondition(text[at++] === ":", "JSONの区切りが不正です。");
        }
        const item = value(depth + 1);
        if (object) result[key] = item;
        else result.push(item);
        whitespace();
        if (text[at] === close) {
          at++;
          return result;
        }
        requireCondition(text[at++] === ",", "JSONの区切りが不正です。");
      }
      throw new AuditFormatError("JSONが閉じていません。");
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(text.slice(at));
    requireCondition(token, "JSONの値が不正です。");
    at += token[0].length;
    const result = JSON.parse(token[0]);
    requireCondition(
      typeof result !== "number" || (Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER),
      "JSONの数値が安全に扱える範囲を超えています。",
    );
    return result;
  }
  try {
    const result = value(0);
    whitespace();
    requireCondition(at === text.length, "JSONの末尾に余分なデータがあります。");
    return result;
  } catch (error) {
    if (error instanceof AuditFormatError) throw error;
    throw new AuditFormatError("JSONの構文が不正です。");
  }
}
