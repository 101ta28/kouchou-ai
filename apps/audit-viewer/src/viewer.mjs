import { LIMITS, decode, readArchive, requireCondition } from "../../../packages/audit-verifier/src/archive.mjs";
import {
  VERIFICATION_LIMITATIONS,
  VERSION,
  compareDocuments,
  verifyArchive,
} from "../../../packages/audit-verifier/src/verify.mjs";

export function startViewer({ buildId: VIEWER_BUILD, samples: SAMPLE_ARCHIVES, workerSource }) {
  const byId = (id) => document.getElementById(id);
  const state = { results: [], names: [], busy: false, sample: false, cancelled: false, cancelWorker: null };
  const labels = {
    completed: "完了",
    failed: "失敗",
    skipped: "スキップ",
    started: "開始",
    not_recorded: "未記録",
    analysis: "分析",
    translation: "翻訳",
    config_edit: "設定の編集",
    cluster_label_edit: "ラベルの編集",
    visibility_edit: "公開範囲の編集",
    visualization_config_edit: "表示設定の編集",
    other: "その他",
    extraction: "意見の抽出",
    embedding: "埋め込み",
    opinion_classification: "意見の分類",
    opinion_stance: "立場の分析",
    opinion_novelty: "新規性の分析",
    hierarchical_clustering: "グループ分け",
    hierarchical_initial_labelling: "初期ラベル",
    hierarchical_merge_labelling: "統合ラベル",
    hierarchical_overview: "概要",
    hierarchical_aggregation: "集計",
    hierarchical_visualization: "可視化",
    llm_grouping: "LLMによるグループ分け",
    input_rows: "入力行数",
    extracted_arguments: "抽出意見数",
    linked_input_ids: "抽出意見に対応する入力ID数",
    unlinked_input_ids: "対応する抽出意見がない入力ID数",
    hash_match: "ハッシュ一致",
    size_only: "サイズのみ一致",
    missing: "ファイル欠落",
    hash_mismatch: "ハッシュ不一致",
    size_mismatch: "サイズ不一致",
    model: "モデル",
    prompts: "プロンプト",
    settings: "設定",
    results: "成果物",
    labels: "ラベル",
    visibility: "公開範囲",
    visualization: "表示設定",
    builtin: "既定テンプレート",
    custom_or_unknown: "独自または不明（本文非公開）",
    original_comments_and_identifiers: "元コメント・個人の識別子",
    generated_text_and_labels: "生成された文章・ラベル",
    custom_prompts_and_model_aliases: "独自プロンプト・モデル別名",
    attributes_and_subgroup_statistics: "属性・属性別集計",
    embeddings_and_binary_artifacts: "埋め込み・バイナリ成果物",
    internal_paths_and_source_links: "内部パス・元データへのリンク",
    credentials_endpoints_and_request_ids: "認証情報・接続先・リクエストID",
    raw_errors_and_diagnostics: "エラー本文・診断情報",
    internal_file_hashes: "内部ファイルのハッシュ",
    exact_counts: "正確な件数",
    unrecognised_fields: "未定義の項目",
    hierarchical: "階層型グループ分け",
    limit: "処理上限",
    workers: "並列処理数",
    timeout_seconds: "タイムアウト（秒）",
    category_batch_size: "分類バッチ件数",
    k: "近傍数",
    seed: "乱数シード",
    sampling_num: "サンプル数",
    group_count: "グループ数",
    discovery_sample_size: "グループ探索のサンプル数",
    assignment_batch_size: "割り当てバッチ件数",
    n_neighbors: "近傍数",
    n_components: "出力次元数",
    enabled: "有効",
    save_umap_model: "UMAPモデルを保存",
    cluster_nums: "階層ごとのグループ数",
    source_run_id: "実行ID",
    started_at: "開始日時",
    finished_at: "終了日時",
    changed_sections: "変更した区分",
    comparison_available: "同じ操作の前後比較",
  };
  const label = (value) => labels[value] ?? value;
  const display = (value) =>
    value === null || value === undefined
      ? "未記録・非公開"
      : typeof value === "boolean"
        ? value
          ? "はい"
          : "いいえ"
        : typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function table(headers, rows) {
    const wrapper = element("div", undefined, "table-wrap");
    const tab = element("table");
    if (headers) {
      const head = element("thead");
      const row = element("tr");
      for (const text of headers) {
        const cell = element("th", text);
        cell.scope = "col";
        row.append(cell);
      }
      head.append(row);
      tab.append(head);
    }
    const body = element("tbody");
    for (const values of rows) {
      const row = element("tr");
      values.forEach((value, index) => {
        const cell = element(!headers && index === 0 ? "th" : "td");
        if (!headers && index === 0) cell.scope = "row";
        if (value instanceof Node) cell.append(value);
        else cell.textContent = display(value);
        row.append(cell);
      });
      body.append(row);
    }
    tab.append(body);
    wrapper.append(tab);
    return wrapper;
  }

  function status(text, tone = "unknown") {
    return element("span", text, `check-label ${tone}`);
  }

  function signatureStatus(report) {
    const name = {
      absent: "署名なし",
      needs_key: "公開鍵が未指定のため未検証",
      valid: "選択した公開鍵と署名が一致",
      invalid: "署名が一致しません",
      different_key: "選択した公開鍵と署名者の鍵が異なります",
    }[report.signature.status];
    const tone =
      report.signature.status === "valid" && report.transferIntegrity === "hashes_match"
        ? "good"
        : ["invalid", "different_key"].includes(report.signature.status) || report.transferIntegrity === "mismatch"
          ? "bad"
          : "unknown";
    return status(name, tone);
  }

  function renderSummary(result, index) {
    const { report } = result;
    const record = element("section", undefined, "record");
    record.append(element("h3", `資料${index === 0 ? "A" : "B"}：${state.names[index]}`));
    const hashes = report.checks.filter((row) => row.status === "hash_match").length;
    const sizes = report.checks.filter((row) => row.status === "size_only").length;
    const integrity =
      report.integrity === "mismatch"
        ? status("不一致・欠落あり", "bad")
        : status(`ハッシュ一致 ${hashes}件 ／ サイズのみ ${sizes}件`, sizes ? "unknown" : "good");
    const rows = [
      ["形式", "対応する形式です"],
      ["元の記録との照合", integrity],
      [
        "受渡し用のハッシュ",
        report.transferIntegrity === "absent"
          ? "受渡し用マニフェストなし"
          : status(
              report.transferIntegrity === "hashes_match" ? "全ファイル一致" : "不一致・欠落あり",
              report.transferIntegrity === "hashes_match" ? "good" : "bad",
            ),
      ],
      ["署名", signatureStatus(report)],
      ["署名に記載された鍵の指紋", report.signature.keyId ?? "署名なし"],
      ["選択した鍵の指紋", report.signature.selectedKeyId ?? "未指定・未検査"],
      [
        "別経路のZIPハッシュ",
        report.externalDigest.status === "not_provided"
          ? "照合値なし"
          : status(
              report.externalDigest.status === "match" ? "一致" : "不一致",
              report.externalDigest.status === "match" ? "good" : "bad",
            ),
      ],
      ["実行ID", element("code", report.sourceRunId)],
      ["資料のZIPのSHA-256", element("code", report.archiveSha256)],
      ["公開資料の識別子", report.releaseId ? element("code", report.releaseId) : "内部記録"],
      ["検査日時（この端末）", report.checkedAt],
    ];
    record.append(
      table(
        null,
        rows.filter(
          (row) =>
            ![
              "署名に記載された鍵の指紋",
              "選択した鍵の指紋",
              "実行ID",
              "資料のZIPのSHA-256",
              "公開資料の識別子",
            ].includes(row[0]),
        ),
      ),
    );
    const identifiers = element("details", undefined, "identifiers");
    identifiers.append(element("summary", "実行ID・ハッシュ・鍵の指紋を確認"));
    identifiers.append(
      table(
        null,
        rows.filter((row) =>
          ["署名に記載された鍵の指紋", "選択した鍵の指紋", "実行ID", "資料のZIPのSHA-256", "公開資料の識別子"].includes(
            row[0],
          ),
        ),
      ),
    );
    record.append(identifiers);
    if (
      report.integrity === "mismatch" ||
      report.transferIntegrity === "mismatch" ||
      report.externalDigest.status === "mismatch" ||
      ["invalid", "different_key"].includes(report.signature.status)
    ) {
      record.append(
        element(
          "p",
          "照合に失敗した項目があります。以下の表示内容を、確認済みの資料として扱わないでください。",
          "notice error",
        ),
      );
    }
    record.append(
      element(
        "p",
        "署名の一致は、選択した鍵による署名を示します。発行者の身元、内容の正しさ、署名時刻をこの画面だけで証明するものではありません。",
        "caption",
      ),
    );
    return record;
  }

  function renderPublic(result, index) {
    const section = element("section", undefined, "section");
    section.append(element("h2", `資料${index === 0 ? "A" : "B"}の内容`));
    const doc = result.document;
    if (!doc) {
      section.append(element("p", "audit.jsonがないため、内容を表示できません。", "notice error"));
      return section;
    }
    section.append(element("h3", "分析条件と実行環境"));
    section.append(
      table(null, [
        ["操作・結果", `${label(doc.kind)} ／ ${label(doc.status)}`],
        ["開始日時（記載値）", doc.started_at],
        ["終了日時（記載値）", doc.finished_at],
        ["モデル", doc.model],
        ["プロバイダー", doc.provider],
        ["分析方式", doc.analysis_mode ? label(doc.analysis_mode) : null],
        ["分析コアの版", doc.software.analysis_core_version],
        ["分析コアのソースSHA-256", doc.software.analysis_core_source_sha256],
        ["Gitコミット", doc.software.git_commit],
        ["未コミット変更あり", doc.software.git_dirty],
        ["公開ポリシー", doc.policy_version],
        ["同じ操作の前後比較", doc.comparison_available ? "比較対象あり" : "比較対象なし"],
        ["変更した区分", doc.changed_sections.length ? doc.changed_sections.map(label).join("、") : "変更の記録なし"],
      ]),
    );
    section.append(element("h3", "処理の状況・設定"));
    const stepRows = doc.steps.map((step) => {
      const settings = element("div", undefined, "value");
      settings.append(
        element(
          "code",
          Object.entries(step.parameters)
            .map(([key, value]) => `${label(key)} (${key}): ${display(value)}`)
            .join("\n") || "記録なし",
        ),
      );
      for (const [name, prompt] of Object.entries(step.prompts))
        settings.append(
          element("p", `${name}：${label(prompt.source)}${prompt.template_id ? ` (${prompt.template_id})` : ""}`),
        );
      return [label(step.name), label(step.status), step.model, settings];
    });
    section.append(
      stepRows.length
        ? table(["処理", "状態", "モデル", "設定・プロンプト"], stepRows)
        : element("p", "処理ごとの記録はありません。"),
    );
    section.append(
      element(
        "p",
        "既定テンプレートの判定は、資料を生成した版の既定値との比較です。独自プロンプトの本文は公開資料に含まれません。",
        "caption",
      ),
    );
    section.append(element("h3", "処理件数の範囲"));
    section.append(
      table(
        null,
        Object.entries(doc.counts).map(([key, range]) => [
          label(key),
          range ? `${range.minimum}〜${range.maximum}件` : "記録から確認できません",
        ]),
      ),
    );
    section.append(
      element(
        "p",
        "件数は10件幅です。0〜9件には0件も含みます。対応する意見がない入力には、対象外・未処理なども含まれ、失敗件数を意味しません。",
        "caption",
      ),
    );
    section.append(element("h3", "公開資料から除外した項目"));
    const list = element("ul");
    for (const item of doc.omitted) list.append(element("li", label(item)));
    section.append(list);
    return section;
  }

  function renderInternal(result) {
    const section = element("section", undefined, "section");
    section.append(element("h2", "内部記録の確認"));
    section.append(
      table(null, [
        ["操作・結果", `${label(result.manifest.kind)} ／ ${label(result.manifest.status)}`],
        ["開始日時（記載値）", result.manifest.started_at],
        ["終了日時（記載値）", result.manifest.finished_at],
      ]),
    );
    section.append(
      element(
        "p",
        "元の記録にハッシュがないファイルは、サイズだけを検査します。受渡し用の署名がある場合も、確認できるのは受渡し資料との一致であり、過去の実行時点からの不変性ではありません。",
        "notice",
      ),
    );
    const files = [...result.archive.entries.keys()].filter((path) => /\.(?:json|jsonl|csv|txt)$/iu.test(path));
    const labelNode = element("label", "内容を確認するテキストファイル", "field-label");
    labelNode.htmlFor = "internal-file";
    const select = element("select");
    select.id = "internal-file";
    for (const path of files) {
      const option = element("option", path);
      option.value = path;
      select.append(option);
    }
    const button = element("button", "テキストを開く", "secondary");
    button.type = "button";
    const output = element("pre");
    output.hidden = true;
    output.setAttribute("aria-label", "選択したファイルの内容");
    const error = element("p", "", "notice error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    button.addEventListener("click", async () => {
      output.hidden = true;
      error.hidden = true;
      try {
        output.textContent = decode(await result.archive.read(select.value, 2 * 1024 * 1024));
        output.hidden = false;
      } catch (problem) {
        error.textContent = problem.message;
        error.hidden = false;
      }
    });
    section.append(
      element("h3", "原文・設定を読む"),
      element(
        "p",
        "選択したテキストだけを表示します（最大2 MiB）。埋め込みやpickleなどのバイナリは実行・表示しません。",
        "caption",
      ),
      labelNode,
      select,
      button,
      error,
      output,
    );
    return section;
  }

  function renderComparison(results) {
    byId("comparison").replaceChildren();
    if (results.length < 2 || results.some((result) => !result.document)) return;
    const changes = compareDocuments(results[0].document, results[1].document);
    const section = element("section", undefined, "section");
    section.append(element("h2", "資料A・Bの違い"));
    section.append(
      element(
        "p",
        "選んだ2つの資料の公開項目を比較しています。同じレポートの連続した実行かどうかや、間に別の実行がないかは確認できません。",
        "caption",
      ),
    );
    section.append(
      changes.length
        ? table(
            ["項目", "資料A", "資料B"],
            changes.map((change) => [
              comparisonLabel(change.path),
              change.beforePresent ? display(change.before) : "項目なし",
              change.afterPresent ? display(change.after) : "項目なし",
            ]),
          )
        : element("p", "公開されている項目に違いはありません。"),
    );
    byId("comparison").append(section);
  }

  function comparisonLabel(path) {
    const pieces = path.split(".");
    const human = pieces[0] === "steps" ? `${label(pieces[1])} / ${label(pieces.at(-1))}` : label(path);
    const node = element("div", human);
    if (human !== path) node.append(element("code", path, "field-code"));
    return node;
  }

  function render() {
    byId("summary").replaceChildren(...state.results.map(renderSummary));
    byId("documents").replaceChildren();
    renderComparison(state.results);
    state.results.forEach((result, index) => {
      byId("documents").append(
        result.report.audience === "public" ? renderPublic(result, index) : renderInternal(result),
      );
      const files = element("section", undefined, "section");
      files.append(element("h2", `資料${index === 0 ? "A" : "B"}のファイル検査`));
      files.append(
        table(
          ["ファイル", "結果", "実際のサイズ"],
          result.report.checks.map((file) => [
            file.path,
            status(
              label(file.status),
              file.status === "hash_match" ? "good" : file.status === "size_only" ? "unknown" : "bad",
            ),
            file.actualBytes === undefined ? "欠落" : `${file.actualBytes.toLocaleString("ja-JP")} bytes`,
          ]),
        ),
      );
      if (result.report.transferChecks.length) {
        files.append(element("h3", "受渡し用マニフェストとの照合"));
        files.append(
          table(
            ["ファイル", "結果"],
            result.report.transferChecks.map((file) => [
              file.path,
              status(label(file.status), file.status === "hash_match" ? "good" : "bad"),
            ]),
          ),
        );
      }
      byId("documents").append(files);
    });
    byId("limitations").replaceChildren(...VERIFICATION_LIMITATIONS.map((text) => element("li", text)));
    byId("sample-notice").hidden = !state.sample;
    byId("private-export-notice").hidden = state.results[0]?.report.audience !== "internal";
    byId("results").hidden = false;
    byId("results-title").focus();
  }

  function invalidate() {
    state.results = [];
    state.names = [];
    byId("results").hidden = true;
    byId("summary").replaceChildren();
    byId("comparison").replaceChildren();
    byId("documents").replaceChildren();
    byId("error").hidden = true;
    byId("activity").textContent = "";
    byId("review-notes").value = "";
  }

  function busy(value) {
    state.busy = value;
    for (const control of byId("audit-form").elements) control.disabled = value;
    byId("cancel-button").hidden = !value;
    byId("cancel-button").disabled = false;
    byId("audit-form").setAttribute("aria-busy", String(value));
  }

  function verifyInWorker(bytes, options) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      let worker;
      try {
        worker = new Worker(url);
      } catch (error) {
        URL.revokeObjectURL(url);
        reject(error);
        return;
      }
      let finished = false;
      const finish = (error, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        state.cancelWorker = null;
        if (error) reject(error);
        else resolve(value);
      };
      state.cancelWorker = () => finish(new Error("検査を中止しました。"));
      const timer = setTimeout(
        () => finish(new Error("検査が120秒を超えたため中止しました。資料のサイズや形式を確認してください。")),
        120000,
      );
      worker.onerror = () =>
        finish(new Error("検証処理を起動できませんでした。対応ブラウザとファイルの形式を確認してください。"));
      worker.onmessage = ({ data }) => {
        if (data.error) finish(new Error(data.error));
        else {
          try {
            finish(null, { ...data.result, archive: readArchive(new Uint8Array(data.buffer)) });
          } catch (error) {
            finish(error);
          }
        }
      };
      try {
        worker.postMessage({ buffer: bytes.buffer, options }, [bytes.buffer]);
      } catch (error) {
        finish(error);
      }
    });
  }

  async function inspect(samples = false) {
    if (state.busy) return;
    if (samples) {
      byId("audit-form").reset();
      updateMode();
    }
    invalidate();
    state.cancelled = false;
    busy(true);
    state.sample = samples;
    byId("activity").textContent = "資料を端末内で検査しています…";
    try {
      const audience = samples ? "public" : document.querySelector('input[name="audience"]:checked').value;
      const primary = byId("primary-file").files[0];
      const secondary = byId("secondary-file").files[0];
      const publicKeyFile = byId("public-key").files[0];
      requireCondition(samples || primary, "資料AのZIPを選んでください。");
      let publicKeyPem = null;
      if (!samples && publicKeyFile) {
        requireCondition(publicKeyFile.size <= 8192, "公開鍵ファイルが大きすぎます。");
        publicKeyPem = await publicKeyFile.text();
      }
      const files = samples ? SAMPLE_ARCHIVES : [primary, ...(audience === "public" && secondary ? [secondary] : [])];
      const results = [];
      const names = [];
      for (const [index, file] of files.entries()) {
        requireCondition(samples || file.size <= LIMITS.archive, "ZIPは128 MiB以下のファイルを選んでください。");
        const bytes = samples
          ? Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))
          : new Uint8Array(await file.arrayBuffer());
        requireCondition(!state.cancelled, "検査を中止しました。");
        names.push(file.name);
        results.push(
          await verifyInWorker(bytes, {
            audience,
            publicKeyPem,
            expectedArchiveSha256: !samples && index === 0 ? byId("expected-digest").value.trim() : "",
          }),
        );
      }
      state.results = results;
      state.names = names;
      render();
      byId("activity").textContent = `${results.length}件の資料を検査しました。下の項目ごとの結果を確認してください。`;
    } catch (error) {
      byId("error").textContent = error.message || "資料を読み込めませんでした。";
      byId("error").hidden = false;
      byId("activity").textContent = "検査を完了できませんでした。";
    } finally {
      busy(false);
    }
  }

  byId("audit-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void inspect();
  });
  byId("sample-button").addEventListener("click", () => {
    void inspect(true);
  });
  byId("cancel-button").addEventListener("click", () => {
    state.cancelled = true;
    state.cancelWorker?.();
  });
  byId("clear-button").addEventListener("click", () => {
    byId("audit-form").reset();
    invalidate();
    updateMode();
    byId("activity").textContent = "読み込んだ資料を消去しました。";
  });
  byId("audit-form").addEventListener("input", invalidate);
  function updateMode() {
    const internal = document.querySelector('input[name="audience"]:checked').value === "internal";
    byId("comparison-input").hidden = internal;
    byId("mode-help").textContent = internal
      ? "個人情報を含み得る内部記録を開きます。監査権限のある資料を使用してください。処理は端末内で行います。"
      : "公開用の資料を開きます。元コメントや個人情報を含む内部記録は読み込みません。";
  }
  for (const input of document.querySelectorAll('input[name="audience"]')) input.addEventListener("change", updateMode);
  byId("download-report").addEventListener("click", () => {
    const output = {
      viewerVersion: VERSION,
      viewerBuildSha256: VIEWER_BUILD,
      sample: state.sample,
      reports: state.results.map((result, index) => ({ fileName: state.names[index], ...result.report })),
      differences:
        state.results.length === 2 && state.results.every((result) => result.document)
          ? compareDocuments(state.results[0].document, state.results[1].document)
          : [],
      reviewerNotes: byId("review-notes").value,
    };
    const blob = new Blob([`${JSON.stringify(output, null, 2)}\n`], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = element("a");
    link.href = url;
    link.download =
      state.results[0]?.report.audience === "internal"
        ? "internal-audit-verification.json"
        : "public-audit-verification.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  byId("print-report").addEventListener("click", () => {
    window.print();
  });
  let printDetails = null;
  window.addEventListener("beforeprint", () => {
    byId("notes-print").textContent = byId("review-notes").value || "メモなし";
    if (printDetails === null)
      printDetails = [...document.querySelectorAll("#results details")].map((node) => [node, node.open]);
    for (const [node] of printDetails) node.open = true;
  });
  window.addEventListener("afterprint", () => {
    for (const [node, wasOpen] of printDetails ?? []) node.open = wasOpen;
    printDetails = null;
  });
  byId("tool-version").textContent = VERSION;
  byId("build-id").textContent = VIEWER_BUILD;
  if (!globalThis.crypto?.subtle || !globalThis.DecompressionStream) {
    byId("error").textContent =
      "この環境では暗号検証またはZIP展開が使えません。対応ブラウザでローカルのHTMLを開いてください。";
    byId("error").hidden = false;
  }
}
