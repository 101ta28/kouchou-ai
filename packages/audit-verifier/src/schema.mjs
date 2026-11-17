import { requireCondition } from "./archive.mjs";

export function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

export function validDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const days = new Date(Date.UTC(+year, +month, 0)).getUTCDate();
  return (
    +year >= 1000 &&
    +month >= 1 &&
    +month <= 12 &&
    +day >= 1 &&
    +day <= days &&
    +hour <= 23 &&
    +minute <= 59 &&
    +second <= 59 &&
    (zone === "Z" || (+zone.slice(1, 3) <= 23 && +zone.slice(4) <= 59)) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Interpreter for the documented JSON Schema subset. No eval or schema downloads. */
export function validateSchema(value, schema, root = schema, path = "$") {
  if (schema.$ref) {
    requireCondition(/^#\/\$defs\/[A-Za-z]+$/u.test(schema.$ref), "対応しないスキーマ参照です。");
    return validateSchema(value, root.$defs[schema.$ref.split("/").at(-1)], root, path);
  }
  if (schema.anyOf) {
    requireCondition(
      schema.anyOf.some((option) => {
        try {
          validateSchema(value, option, root, path);
          return true;
        } catch {
          return false;
        }
      }),
      `形式が一致しません: ${path}`,
    );
  }
  if (Object.hasOwn(schema, "const")) requireCondition(sameValue(value, schema.const), `規定値と一致しません: ${path}`);
  if (schema.enum)
    requireCondition(
      schema.enum.some((candidate) => sameValue(candidate, value)),
      `未対応の値です: ${path}`,
    );
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (schema.type)
    requireCondition(
      schema.type === "integer" ? Number.isSafeInteger(value) : actual === schema.type,
      `型が一致しません: ${path}`,
    );
  if (actual === "object") {
    for (const key of schema.required ?? [])
      requireCondition(Object.hasOwn(value, key), `必須項目がありません: ${path}.${key}`);
    for (const [key, item] of Object.entries(value)) {
      const child = schema.properties?.[key];
      if (child) validateSchema(item, child, root, `${path}.${key}`);
      else if (schema.additionalProperties === false) requireCondition(false, `未定義の項目です: ${path}.${key}`);
      else if (typeof schema.additionalProperties === "object")
        validateSchema(item, schema.additionalProperties, root, `${path}.${key}`);
    }
  }
  if (actual === "array") {
    requireCondition(schema.maxItems === undefined || value.length <= schema.maxItems, `項目数が多すぎます: ${path}`);
    requireCondition(
      schema.minItems === undefined || value.length >= schema.minItems,
      `項目数が不足しています: ${path}`,
    );
    if (schema.uniqueItems)
      requireCondition(
        new Set(value.map((item) => JSON.stringify(item))).size === value.length,
        `項目が重複しています: ${path}`,
      );
    if (schema.items) value.forEach((item, index) => validateSchema(item, schema.items, root, `${path}[${index}]`));
  }
  if (actual === "string") {
    if (schema.pattern) requireCondition(new RegExp(schema.pattern, "u").test(value), `書式が一致しません: ${path}`);
    if (schema.format === "date-time") requireCondition(validDate(value), `日時が不正です: ${path}`);
  }
  if (actual === "number") {
    requireCondition(Number.isFinite(value), `数値が不正です: ${path}`);
    if (schema.minimum !== undefined) requireCondition(value >= schema.minimum, `数値が下限を下回ります: ${path}`);
    if (schema.maximum !== undefined) requireCondition(value <= schema.maximum, `数値が上限を超えます: ${path}`);
    if (schema.multipleOf) requireCondition(value % schema.multipleOf === 0, `数値の単位が不正です: ${path}`);
  }
}

export function validatePublic(document, schema) {
  validateSchema(document, schema);
  requireCondition(
    Date.parse(document.finished_at) >= Date.parse(document.started_at),
    "終了日時が開始日時より前です。",
  );
  requireCondition(
    new Set(document.steps.map((step) => step.name)).size === document.steps.length,
    "処理の記録が重複しています。",
  );
  for (const range of Object.values(document.counts)) {
    if (range !== null) requireCondition(range.maximum === range.minimum + 9, "件数が10件幅になっていません。");
  }
  for (const step of document.steps) {
    for (const [key, prompt] of Object.entries(step.prompts)) {
      const expected = key === "prompt" ? step.name : `llm_grouping_${key.replace(/_prompt$/u, "")}`;
      requireCondition(
        prompt.source === "builtin" ? prompt.template_id === expected : prompt.template_id === null,
        "プロンプトの種別とテンプレートIDが一致しません。",
      );
    }
  }
}
