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
    started: "完了の記録なし",
    not_recorded: "記録なし",
    analysis: "分析",
    translation: "翻訳",
    config_edit: "設定の編集",
    cluster_label_edit: "ラベルの編集",
    visibility_edit: "公開範囲の編集",
    visualization_config_edit: "表示設定の編集",
    other: "その他",
    extraction: "意見の抽出",
    embedding: "意見を比較するための数値化",
    opinion_classification: "意見の分類",
    opinion_stance: "立場の分析",
    opinion_novelty: "新規性の分析",
    hierarchical_clustering: "グループ分け",
    hierarchical_initial_labelling: "グループの名前・説明を作成",
    hierarchical_merge_labelling: "大きなグループの名前・説明を作成",
    hierarchical_overview: "全体の概要を作成",
    hierarchical_aggregation: "集計",
    hierarchical_visualization: "可視化",
    llm_grouping: "AIによるグループ分け",
    input_rows: "元のコメント数",
    extracted_arguments: "取り出した意見の数",
    linked_input_ids: "抽出した意見と対応する入力数",
    unlinked_input_ids: "対応する抽出意見がない入力数",
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
    hierarchical: "似た意見を階層的にグループ分け",
    limit: "分析するコメントの上限",
    workers: "同時に進める処理数",
    timeout_seconds: "1回の処理を待つ上限",
    category_batch_size: "一度に扱う分類項目数",
    k: "比較する近くの意見の数",
    seed: "計算に使う乱数の初期値",
    sampling_num: "参考にする意見数",
    group_count: "グループ数",
    discovery_sample_size: "グループを決めるために参考にする意見数",
    assignment_batch_size: "一度にグループへ振り分ける件数",
    n_neighbors: "比較する近くの意見の数",
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

  function fields(rows, className = "fact-grid") {
    const list = element("dl", undefined, className);
    for (const [name, value, description] of rows) {
      const item = element("div", undefined, "fact");
      item.append(element("dt", name), element("dd", display(value)));
      if (description) item.append(element("dd", description, "fact-help"));
      list.append(item);
    }
    return list;
  }

  function dateText(value) {
    return value
      ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value))
      : "記録なし";
  }

  function hasMismatch(report) {
    return (
      report.integrity === "mismatch" ||
      report.transferIntegrity === "mismatch" ||
      report.externalDigest.status === "mismatch" ||
      ["invalid", "different_key"].includes(report.signature.status)
    );
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
    const record = element("section", undefined, "verification");
    const prefix = state.results.length > 1 ? `資料${index === 0 ? "A" : "B"}：` : "";
    const mismatch = hasMismatch(report);
    const message = element("div", undefined, `verification-message${mismatch ? " notice error" : ""}`);
    message.append(
      status(
        `${prefix}${mismatch ? "ファイルの確認で問題が見つかりました" : "ファイルを読み込みました"}`,
        mismatch ? "bad" : "good",
      ),
      element(
        "p",
        mismatch
          ? "不一致・欠落などがあります。下に表示する内容を、確認済みの資料として扱わないでください。"
          : "資料に記録された条件を表示します。分析の正確さや公平さを判定するものではありません。",
        "caption",
      ),
    );
    record.append(message);
    const details = element("details", undefined, "technical-details");
    details.open = true;
    details.append(element("summary", "ファイルの照合結果を詳しく見る"));
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
    details.append(
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
    details.append(identifiers);
    details.append(
      element(
        "p",
        "署名の一致は、選択した鍵による署名を示します。発行者の身元、内容の正しさ、署名時刻をこの画面だけで証明するものではありません。",
        "caption",
      ),
    );
    record.append(details);
    return record;
  }

  function renderPublic(result, index) {
    const section = element("section", undefined, "analysis-record");
    const doc = result.document;
    if (!doc) {
      section.append(element("p", "分析の記録ファイルが見つからないため、内容を表示できません。", "notice error"));
      return section;
    }
    const overview = element("div", undefined, "overview-panel");
    overview.append(
      element("p", state.results.length > 1 ? `資料${index === 0 ? "A" : "B"}` : "読み込んだ資料", "eyebrow"),
    );
    const heading = element("div", undefined, "record-heading");
    heading.append(
      element("h2", "分析条件と実行環境"),
      status(`${label(doc.kind)}：${label(doc.status)}`, doc.status === "failed" ? "bad" : "good"),
    );
    overview.append(heading, element("p", state.names[index], "source-name"));
    if (doc.kind !== "analysis") {
      overview.append(
        element(
          "p",
          "これは編集・翻訳などの操作の記録です。新しく分析を実行したことを示すものではありません。",
          "notice",
        ),
      );
    }
    const providers = {
      openai: "OpenAI",
      azure: "Microsoft Azure",
      gemini: "Google Gemini",
      openrouter: "OpenRouter",
      local: "ローカル環境",
    };
    overview.append(
      fields([
        ["使ったAI", doc.model, "記録されているモデル名。処理ごとに異なる場合は下に表示します。"],
        ["AIの提供元・実行先", providers[doc.provider] ?? doc.provider],
        ["分析の方法", doc.analysis_mode ? label(doc.analysis_mode) : null],
        [
          "使用したソフトウェア",
          doc.software.analysis_core_version ? `広聴AI 分析エンジン ${doc.software.analysis_core_version}` : null,
        ],
      ]),
    );
    overview.append(
      fields(
        [
          ["開始日時", dateText(doc.started_at)],
          ["終了日時", dateText(doc.finished_at)],
        ],
        "date-grid",
      ),
    );
    overview.append(
      element(
        "p",
        "日時はこの端末の時間帯で表示しています。未記録・非公開の項目は、この資料からは確認できません。",
        "caption",
      ),
    );
    const jump = element("a", "処理の状況・設定を見る", "process-link");
    jump.href = `#process-${index}`;
    overview.append(jump);
    section.append(overview);

    const counts = element("div", undefined, "counts-panel");
    counts.append(element("h3", "資料に記録された件数"));
    counts.append(
      fields(
        ["input_rows", "extracted_arguments", "linked_input_ids", "unlinked_input_ids"].map((key) => {
          const range = doc.counts[key];
          return [
            label(key),
            range ? `${range.minimum.toLocaleString("ja-JP")}〜${range.maximum.toLocaleString("ja-JP")}件` : null,
          ];
        }),
        "count-grid",
      ),
    );
    counts.append(
      element(
        "p",
        "件数は10件幅で公開されています。0〜9件には0件も含みます。対応する意見がない入力には、対象外・未処理なども含まれ、失敗件数を意味しません。",
        "caption",
      ),
    );
    section.append(counts);

    const process = element("section", undefined, "process-panel");
    process.id = `process-${index}`;
    process.append(
      element("h3", "処理の状況・設定"),
      element("p", "各処理の役割と、記録されている設定を確認できます。", "caption"),
    );
    const totals = element("div", undefined, "step-totals");
    for (const stateName of ["completed", "failed", "skipped", "started", "not_recorded"]) {
      const count = doc.steps.filter((step) => step.status === stateName).length;
      if (count)
        totals.append(
          status(
            `${label(stateName)} ${count}件`,
            stateName === "failed" ? "bad" : stateName === "completed" ? "good" : "unknown",
          ),
        );
    }
    process.append(totals);
    const steps = element("ol", undefined, "step-list");
    doc.steps.forEach((step, position) => steps.append(renderStep(step, position)));
    process.append(doc.steps.length ? steps : element("p", "処理ごとの記録はありません。", "notice"));
    section.append(process);

    const details = element("details", undefined, "technical-details environment-details");
    details.append(element("summary", "実行環境の詳しい情報・公開していない項目"));
    details.append(
      table(null, [
        ["分析コアのソースSHA-256", doc.software.analysis_core_source_sha256],
        ["Gitコミット", doc.software.git_commit],
        ["未コミット変更あり", doc.software.git_dirty],
        ["公開ポリシー", doc.policy_version],
        ["同じ操作の前後比較", doc.comparison_available ? "比較対象あり" : "比較対象なし"],
        ["変更した区分", doc.changed_sections.length ? doc.changed_sections.map(label).join("、") : "変更の記録なし"],
      ]),
    );
    details.append(element("h3", "公開資料に含まれない情報"));
    const list = element("ul");
    for (const item of doc.omitted) list.append(element("li", label(item)));
    details.append(list);
    section.append(details);
    return section;
  }

  function parameterValue(key, value) {
    if (value === null || value === undefined) return display(value);
    if (key === "cluster_nums") return value.map((count, index) => `${index + 1}階層目：${count}グループ`).join(" ／ ");
    if (["limit", "sampling_num", "discovery_sample_size", "assignment_batch_size"].includes(key))
      return `${value.toLocaleString("ja-JP")}件`;
    if (key === "timeout_seconds") return `${value}秒`;
    if (key === "category_batch_size") return `${value}項目`;
    if (key === "enabled" || key === "save_umap_model") return value ? "有効" : "無効";
    return display(value);
  }

  function renderStep(step, position) {
    const descriptions = {
      extraction: "元のコメントから、分析に使う意見を取り出す処理です。",
      embedding: "意見の内容を数値に変換し、意味の近さを比較できるようにする処理です。",
      opinion_classification: "設定した分類に沿って、意見を振り分ける処理です。",
      opinion_stance: "意見が示す賛否などの立場を分析する処理です。",
      opinion_novelty: "他の意見との離れ具合を、数値にする処理です。",
      hierarchical_clustering: "意味が近い意見をグループにまとめ、階層的に整理する処理です。",
      hierarchical_initial_labelling: "各グループの意見を参考に、名前と説明を作る処理です。",
      hierarchical_merge_labelling: "下位のグループをまとめたグループに、名前と説明を付ける処理です。",
      hierarchical_overview: "分析した意見の全体像を、文章にまとめる処理です。",
      hierarchical_aggregation: "各処理の結果をまとめて、レポート用のデータを作る処理です。",
      hierarchical_visualization: "分析結果を図などで確認できるようにする処理です。",
      llm_grouping: "AIを使って意見のグループを決め、各意見を振り分ける処理です。",
    };
    const item = element("li", undefined, `step-card step-${step.status}`);
    const content = element("details", undefined, "step-content");
    content.open = step.status !== "skipped";
    item.append(content);
    const heading = element("summary", undefined, "step-heading");
    const number = element("span", String(position + 1).padStart(2, "0"), "step-number");
    number.setAttribute("aria-hidden", "true");
    heading.append(
      number,
      element("h4", label(step.name)),
      status(label(step.status), step.status === "completed" ? "good" : step.status === "failed" ? "bad" : "unknown"),
    );
    content.append(heading, element("p", descriptions[step.name], "step-description"));
    if (step.status === "skipped")
      content.append(
        element("p", "この実行では処理を省略しています。過去の結果を再利用した場合も含みます。", "step-note"),
      );
    if (step.status === "started")
      content.append(element("p", "処理を開始した記録はありますが、完了したかは確認できません。", "step-note"));
    if (step.status === "failed")
      content.append(
        element("p", "この処理は失敗として記録されています。エラーの詳しい内容は公開資料に含まれません。", "step-note"),
      );
    const rows = [];
    if (step.model) rows.push(["使ったAI", step.model]);
    for (const [key, value] of Object.entries(step.parameters)) rows.push([label(key), parameterValue(key, value)]);
    if (rows.length) content.append(fields(rows, "parameter-grid"));
    else content.append(element("p", "この処理の個別設定は記録されていません。", "caption"));

    const prompts = Object.entries(step.prompts);
    if (prompts.length) {
      const instructions = element("div", undefined, "prompt-info");
      const promptNames = {
        prompt: "AIへの指示文",
        discovery_prompt: "グループを決める指示文",
        assignment_prompt: "意見を振り分ける指示文",
      };
      for (const [name, prompt] of prompts)
        instructions.append(
          element(
            "p",
            `${promptNames[name] ?? name}：${prompt.source === "builtin" ? "標準の指示文を使用" : "標準とは異なる、または判定できない指示文（本文非公開）"}`,
          ),
        );
      content.append(instructions);
    }
    const identifiers = element("details", undefined, "step-identifiers");
    identifiers.append(
      element("summary", "設定の識別情報"),
      table(null, [
        ["処理ID", step.name],
        ...Object.entries(step.parameters).map(([key, value]) => [key, display(value)]),
        ...prompts.map(([name, prompt]) => [
          name,
          `${label(prompt.source)}${prompt.template_id ? ` (${prompt.template_id})` : ""}`,
        ]),
      ]),
    );
    identifiers.append(
      element(
        "p",
        "標準の指示文かどうかは、資料を生成した版の既定値との比較です。指示文の本文は公開資料に含まれません。",
        "caption",
      ),
    );
    content.append(identifiers);
    return item;
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
    if (human !== path) {
      const identifier = element("details", undefined, "step-identifiers");
      identifier.append(element("summary", "項目の識別名"), element("code", path, "field-code"));
      node.append(identifier);
    }
    return node;
  }

  function render() {
    byId("summary").replaceChildren(...state.results.map(renderSummary));
    byId("warnings").replaceChildren(
      ...state.results.flatMap((result, index) =>
        hasMismatch(result.report)
          ? [
              element(
                "p",
                `資料${index === 0 ? "A" : "B"}の照合で不一致・欠落などが見つかりました。下に表示する内容を、確認済みの資料として扱わないでください。`,
                "notice error",
              ),
            ]
          : [],
      ),
    );
    byId("verification-panel").open = state.results.some((result) => hasMismatch(result.report));
    byId("documents").replaceChildren();
    renderComparison(state.results);
    state.results.forEach((result, index) => {
      byId("documents").append(
        result.report.audience === "public" ? renderPublic(result, index) : renderInternal(result),
      );
      const files = element("details", undefined, "technical-details file-checks");
      files.append(element("summary", `資料${index === 0 ? "A" : "B"}のファイルごとの照合結果`));
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
      byId("summary").children[index].append(files);
    });
    byId("limitations").replaceChildren(...VERIFICATION_LIMITATIONS.map((text) => element("li", text)));
    byId("sample-notice").hidden = !state.sample;
    byId("private-export-notice").hidden = state.results[0]?.report.audience !== "internal";
    byId("results").hidden = false;
    byId("input-panel").open = false;
    byId("input-title").textContent = "別の資料を開く・比較する";
    document.body.classList.add("has-results");
    byId("results-title").focus();
  }

  function invalidate() {
    state.results = [];
    state.names = [];
    byId("results").hidden = true;
    byId("input-panel").open = true;
    byId("input-title").textContent = "監査資料を開く";
    document.body.classList.remove("has-results");
    byId("summary").replaceChildren();
    byId("warnings").replaceChildren();
    byId("verification-panel").open = false;
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
    byId("activity").textContent = "資料を読み込み、ファイルの内容を確認しています…";
    try {
      const audience = samples ? "public" : document.querySelector('input[name="audience"]:checked').value;
      const primary = byId("primary-file").files[0];
      const secondary = byId("secondary-file").files[0];
      const publicKeyFile = byId("public-key").files[0];
      requireCondition(samples || primary, "レポートから取得したZIPファイルを選んでください。");
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
      byId("activity").textContent =
        `${results.length}件の資料を読み込みました。分析条件と処理の記録を表示しています。`;
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
