# Independent audit exchange format, version 1

This document specifies the bytes and checks needed to implement a separate verifier. Neither the analysis engine nor the application API is required. The reference implementation uses browser Web Crypto, Compression Streams, and JavaScript without runtime dependencies.

## What a successful check means

Keep these results separate. Do not collapse them into “audit passed”.

| Check | Meaning | Does not establish |
| --- | --- | --- |
| Original file SHA-256 | Supplied bytes match the digest in the original manifest | Truth of the original manifest |
| Original file size | Supplied bytes have the recorded length | Content equality |
| Transfer SHA-256 | Every original archive member matches the transfer manifest | Equality to an earlier operational state |
| JWS with an independently obtained key | The supplied key validates the signature over the transfer manifest | The signer's honesty, model weights, fairness, signing time or current key revocation status |
| Independently obtained ZIP digest | The complete ZIP matches the separately supplied digest | The authenticity of the source of that digest |

A signature can remain valid while a referenced file fails its hash check. Both checks MUST be performed. A verifier MUST report an absent or unknown key separately from a signature mismatch. No identity or key supplied within the ZIP is automatically trusted. No trusted time or online revocation lookup is implemented by this profile.

## Archive profile

ZIP, a single disk, stored (method 0) or raw DEFLATE (method 8). Names are ASCII or UTF-8 with the UTF-8 flag. Files are ordinary files with no directory entries, symlinks, preamble, trailing data, archive/entry comments, extra fields, data descriptors, encryption, or ZIP64. Local headers must match the central directory. Entries are contiguous and in central-directory order. The profile is intentionally narrower than general ZIP; the original Python exporter and the release tool both produce this profile.

Limits: 128 MiB compressed archive, 64 MiB per uncompressed member, 256 MiB total uncompressed bytes, 4,096 members, 4 MiB for JSON documents, 32 KiB for a JWS file, and 8 KiB for a public key. Check declared limits before decompression and actual length during decompression. Verify CRC-32 (ZIP/ISO-HDLC) and exact uncompressed lengths. Reject duplicate paths, absolute paths, `.`/`..` components, empty components, backslashes, colons and ASCII control characters. Names have at most 512 JavaScript UTF-16 code units. Do not extract members to arbitrary filesystem paths.

JSON is UTF-8 with no BOM. Reject duplicate member names, trailing input, invalid UTF-8, unpaired surrogates, non-finite numbers, prototype-related keys (`__proto__`, `prototype`, `constructor`), and numbers outside ±(2^53−1). Maximum nesting depth is 48, maximum value count 200,000. These constraints apply before schema validation. ZIP and JSON parsing failures are errors, never evidence of verification success.

## Original public archive

Exactly `audit.json` and `manifest.json`. Optionally add the transfer and signature members described below. Additional files MUST be rejected. The public manifest has exactly these keys:

```json
{
  "schema_version": 1,
  "audience": "public",
  "policy_version": "public-audit-v1",
  "source_run_id": "20261117T000000000000Z-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "files": [{"path": "audit.json", "sha256": "<64 lowercase hexadecimal characters>", "bytes": 2355}],
  "notice": "Review required before sharing. This archive contains no proof of source-text fidelity."
}
```

The byte count above is illustrative; always calculate it from the actual artifact. `files` contains exactly one entry. Hash **the stored, uncompressed bytes**, including whitespace and the final newline. Do not parse and reserialize JSON before hashing. `release_id` is SHA-256 of those `audit.json` bytes. Its value equals the application release ID for archives produced by the original exporter. A ZIP hash is different: it covers the complete ZIP bytes and changes when packaging or signatures change.

Validate the document against `formats/public-audit-v1.schema.json`. Additionally:

- Run IDs use `YYYYMMDDTHHMMSSffffffZ-<32 lowercase hex characters>`.
- Timestamps are valid Gregorian ISO dates with an explicit timezone, year 1000 or later, seconds, and optional 1–6 fractional digits. Seconds are 00–59. The end must not precede the start.
- Count ranges have a lower bound divisible by 10 and an upper bound exactly 9 larger. Null means unknown, not zero.
- Step names are unique. For a builtin `prompt`, `template_id` equals the step name. Builtin `discovery_prompt` and `assignment_prompt` use `llm_grouping_discovery` and `llm_grouping_assignment`. Other prompt sources have null template IDs.
- All fields, model identifiers, options, omissions and limitations follow the versioned allowlists. Unknown versions or values are not silently accepted.

Two public documents may be compared by property, with `steps` matched by name rather than position. Such a comparison says nothing about whether the documents are consecutive runs or belong to the same report; the public profile intentionally omits report identifiers and private history links.

## Original internal archive

Requires an explicit internal mode. `manifest.json` is the existing schema-version-1 analysis manifest, with a valid `run_id`, final `completed` or `failed` status, start/end timestamps and a nonempty `files` array. Each file entry has `path`, integer `bytes`, and optionally `sha256`, `redacted`, `sanitized`, `parse_status`. A SHA-256, when present, is 64 lowercase hexadecimal characters. Missing files, size mismatches and hash mismatches are failures. Without a hash, report **size-only**; never “content verified”.

Members must be exactly the original manifest and the files it lists, with optional transfer/signature members. `manifest.json`, `transfer.json` and `signature.jws.json` are reserved names and cannot appear in the original `files` list. Do not execute pickle, HTML, scripts, macros, or other archived content. The viewer only displays explicitly selected UTF-8 text files up to 2 MiB using text nodes. Internal verification reports may themselves contain sensitive paths or identifiers.

## Transfer manifest

`transfer.json` follows `formats/transfer-v1.schema.json`. Its `files` is a complete, unique list of the original manifest and every original file. It excludes `transfer.json` itself and `signature.jws.json`. No other member is allowed. `audience` and `source_run_id` must match the original manifest. Verify **all** listed lengths and hashes, including original files that had only a size recorded. An unsigned transfer manifest can be checked for consistency, but is not an independent authenticity claim.

The original files and original manifest remain byte-for-byte unchanged. The additional hashes describe the transfer copy; they do not retroactively establish hashes at analysis time.

## Detached JWS signature

`signature.jws.json` uses the detached flattened JSON serialization of [RFC 7515, Appendix F](https://www.rfc-editor.org/rfc/rfc7515.html#appendix-F). It contains only `protected` and `signature`; `payload` and an unprotected `header` are omitted. Base64url is unpadded and canonical. Decode `protected` as strict JSON with exactly:

```json
{
  "alg": "ES256",
  "kid": "sha256:<SHA-256 of the DER-encoded SPKI public key>",
  "typ": "application/vnd.kouchou.audit-transfer+jws"
}
```

Only [ES256 from RFC 7518](https://www.rfc-editor.org/rfc/rfc7518.html#section-3.4) is allowed: ECDSA on P-256 with SHA-256. The 64-byte signature is the fixed-width unsigned big-endian `R || S` encoding (32 bytes each), not ASN.1 DER.

The signed message is the ASCII/UTF-8 concatenation:

```text
protected + "." + BASE64URL(exact uncompressed bytes of transfer.json)
```

Import a **separately obtained** SPKI PEM public key. Confirm it is P-256, calculate its SPKI SHA-256 and compare to `kid`, verify the signature, and separately verify every transfer file. A wrong key or invalid signature is a failure. With no public key, report “not verified”; with no signature, report “unsigned”. The reference CLI returns failure when a public key is explicitly required but no matching signature is available.

This profile is unrelated to authentication JWTs and has no `none`, HMAC, arbitrary algorithm, embedded JWK, `jku`, `x5u`, or remote schema/key lookup. It performs no network access.

## Test artifacts and independent implementations

`fixtures/README.md` gives the expected outcomes for actual Python-produced public ZIPs and synthetic private evidence. `tests/verify.test.mjs` covers byte tampering, missing data, unknown fields/versions, duplicate JSON names, ZIP parser attacks, separate trust anchors and comparison. `tests/release.test.mjs` covers signing, encrypted signing keys, preservation of original bytes, same-size modifications of originally unhashed files, and public-only collections.

Reimplementation does not require this JavaScript library. Use the JSON schemas, these semantic constraints, standard SHA-256, ZIP/DEFLATE and ES256 libraries. Preserve distinct results and the described limits. Never claim source accuracy from integrity checks alone.
