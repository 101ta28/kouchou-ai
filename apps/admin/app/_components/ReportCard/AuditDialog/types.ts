export type Publication = {
  status: "published" | "withdrawn";
  release_id: string | null;
  updated_at: string;
};

export type AuditRecord = {
  run_id: string;
  kind: string;
  status: "completed" | "failed" | "incomplete";
  started_at: string;
  finished_at: string | null;
  publication: Publication | null;
};

export type AuditPage = {
  total: number;
  records: AuditRecord[];
  recommended_record?: AuditRecord | null;
};
export type CountRange = { minimum: number; maximum: number } | null;
export type PublicAuditDocument = {
  source_run_id: string;
  kind: string;
  status: "completed" | "failed";
  started_at: string;
  finished_at: string;
  provider: string | null;
  model: string | null;
  analysis_mode: string | null;
  policy_version: string;
  counts: {
    input_rows: CountRange;
    extracted_arguments: CountRange;
    linked_input_ids: CountRange;
    unlinked_input_ids: CountRange;
  };
  steps: {
    name: string;
    status: string;
    model: string | null;
    parameters: Record<string, number | boolean | null | number[]>;
    prompts: Record<string, { source: string; template_id: string | null }>;
  }[];
  changed_sections: string[];
  comparison_available: boolean;
  software: Record<string, string | boolean | null>;
  omitted: string[];
  limitations: string[];
};

export type AuditPreview = {
  document: PublicAuditDocument;
  sha256: string;
  publication: Publication | null;
};

export const kindLabels: Record<string, string> = {
  analysis: "分析",
  translation: "翻訳",
  config_edit: "レポート情報の編集",
  cluster_label_edit: "意見グループの編集",
  visibility_edit: "公開範囲の変更",
  visualization_config_edit: "表示設定の変更",
  other: "その他の操作",
};

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
