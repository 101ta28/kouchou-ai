import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const sampleTargets = [join(repoRoot, "apps/public-viewer/public/samples"), join(repoRoot, "docs/use-cases/samples")];
const testDataTargets = [
  join(repoRoot, "apps/public-viewer/public/samples/test-data"),
  join(repoRoot, "docs/use-cases/samples/test-data"),
];

const quote = (value) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const csv = (headers, rows) =>
  `${[headers.join(","), ...rows.map((row) => headers.map((header) => quote(row[header] ?? "")).join(","))].join("\n")}\n`;

const writeToTargets = (targets, relativePath, content) => {
  for (const target of targets) {
    const path = join(target, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
};

const writeSample = (relativePath, content) => writeToTargets(sampleTargets, relativePath, content);
const writeTestData = (relativePath, content) => writeToTargets(testDataTargets, relativePath, content);

const expansionContexts = [
  "同じ立場の利用者からも",
  "別の地区の回答でも",
  "説明会後の意見としても",
  "家族や支援者の視点でも",
  "日常的に利用する人からも",
  "初めて制度を調べた人からも",
  "平日昼間に動きづらい人からも",
  "地域活動に関わる人からも",
];

const expansionReasons = [
  "利用する時間帯や曜日で困り方が変わるため",
  "情報の届き方に個人差があるため",
  "費用負担と手続きの分かりやすさが利用を左右するため",
  "地区ごとの距離や交通手段の違いが大きいため",
  "急な予定変更に対応できるかが重要なため",
  "家族に頼れない場合の選択肢が必要なため",
  "窓口、紙、Webのどれでも確認できることが大切なため",
  "実際の生活動線に合う運用でないと使い続けにくいため",
];

const expansionRequests = [
  "具体的な運用条件まで示してほしいです。",
  "地域別の影響を確認してから判断してほしいです。",
  "試行期間を設けて利用者の声を再確認してほしいです。",
  "対象者に届く案内方法も合わせて検討してほしいです。",
  "必要な人が使えなくならないよう段階的に見直してほしいです。",
  "利用実績だけでなく困っている人の声も判断材料にしてほしいです。",
  "変更後の問い合わせ先と代替手段を分かりやすく示してほしいです。",
  "関係する部署や地域団体と連携して改善してほしいです。",
];

const expansionSupplements = [
  "朝の利用だけでなく帰宅時の困りごとも確認したいです",
  "休日や長期休暇の利用場面も想定してほしいです",
  "説明を読んだだけでは判断しにくい点を窓口で補えると助かります",
  "急な予定変更があった場合の扱いも先に示してほしいです",
  "利用できない人がどこに相談すればよいか分かるようにしてほしいです",
  "制度変更の前後で負担がどう変わるかを比べられる資料が必要です",
  "地区ごとの実情を一律に扱わないでほしいです",
  "初めて使う人でも迷わない案内があると利用しやすくなります",
  "家族や支援者が代わりに確認できる情報も整えてほしいです",
  "紙の案内とWebの内容が食い違わないようにしてほしいです",
  "利用者数だけでなく断念した人の理由も把握してほしいです",
  "窓口で聞かれやすい質問を先に整理して公開してほしいです",
  "対象外になる人への代替策も同時に説明してほしいです",
  "地域団体が周知に協力できる形にしてほしいです",
  "費用や時間の負担が増える人への配慮が必要です",
  "混雑する時期と空いている時期を分けて考えてほしいです",
  "高齢者や子ども連れなど移動しにくい人の動線も見てほしいです",
  "問い合わせへの回答を後から確認できるようにしてほしいです",
  "試行後に見直す基準をあらかじめ示してほしいです",
  "利用条件が変わる場合は十分な周知期間を取ってほしいです",
  "申請や予約の締切が生活実態に合っているか確認してほしいです",
  "関係する施設や事業者にも同じ情報が届くようにしてほしいです",
  "小さな困りごとでも投稿しやすい仕組みがあると改善につながります",
  "地区別の集計結果を住民にも分かる形で返してほしいです",
  "利用できる人とできない人の差が広がらないようにしてほしいです",
  "説明会に来られない人の意見も集める工夫が必要です",
  "実際に使う場面を想定した例を複数示してほしいです",
  "短期的な対応と長期的な見直しを分けて検討してほしいです",
  "担当部署が変わっても同じ説明を受けられるようにしてほしいです",
  "地域の既存資源を活用できるかも合わせて検討してほしいです",
  "困っている人ほど声を出しにくい点を前提に調査してほしいです",
  "変更内容を一度に進めず、影響を見ながら調整してほしいです",
  "利用者の属性ごとに必要な支援が違うことを踏まえてほしいです",
  "現場で対応する職員や支援者の負担も確認してほしいです",
  "案内文は専門用語を避けて短く整理してほしいです",
  "利用後の不便を伝えられる窓口を残してほしいです",
  "次回の見直し時期と確認する指標を明確にしてほしいです",
];

const buildExpandedText = (comment, index, cycle, attributes = {}) => {
  if (cycle === 0) {
    return comment;
  }

  const area = attributes.area ?? attributes.district ?? "";
  const stakeholder =
    attributes.stakeholder ?? attributes.caregiver_type ?? attributes.position ?? attributes.age_group ?? "";
  const attributePrefix =
    area && stakeholder
      ? `${area}の${stakeholder}からは、`
      : area
        ? `${area}からは、`
        : stakeholder
          ? `${stakeholder}からは、`
          : "";
  const seed = index + cycle * 13;

  return `${comment} ${attributePrefix}${expansionContexts[seed % expansionContexts.length]}、${
    expansionReasons[(seed + 3) % expansionReasons.length]
  }、${expansionRequests[(seed + 5) % expansionRequests.length]} 補足として、${
    expansionSupplements[(cycle - 1) % expansionSupplements.length]
  }。`;
};

const expandScenarioRows = (scenario) => {
  const targetCount = scenario.targetCommentCount ?? scenario.comments.length;
  return Array.from({ length: targetCount }, (_, index) => {
    const [comment, _clusterIds, _x, _y, attributes = {}] = scenario.comments[index % scenario.comments.length];
    const cycle = Math.floor(index / scenario.comments.length);
    return {
      id: index + 1,
      comment: buildExpandedText(comment, index, cycle, attributes),
      ...attributes,
    };
  });
};

const catalog = JSON.parse(readFileSync(join(repoRoot, "apps/public-viewer/app/sample-site/catalog.json"), "utf8"));
for (const scenario of catalog.scenarios) {
  const rows = expandScenarioRows(scenario);
  const attributeHeaders = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row).filter((key) => key !== "id" && key !== "comment"))),
  );
  writeSample(`${scenario.slug}.csv`, csv(["id", "comment", ...attributeHeaders], rows));
}

const areas = ["中央", "北部", "南部", "東部", "西部"];
const ages = ["10代", "20代", "30代", "40代", "50代", "60代", "70代以上"];
const themes = ["地域交通", "子育て支援", "公共施設", "防災", "広報"];
const comments = [
  "手続きや制度の情報が複数のページに分かれていて、必要な情報を探すのに時間がかかります。",
  "平日の昼間だけでなく、仕事後や休日にも相談できる窓口があると利用しやすいです。",
  "地域によって利用できるサービスに差があるため、地区ごとの状況を見ながら改善してほしいです。",
  "説明会に参加できない人向けに、資料と質問への回答を後から確認できる場所がほしいです。",
  "困っている人ほど情報にたどり着きにくいので、広報紙や窓口でも分かりやすく案内してほしいです。",
];

const makeRows = (count) =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    comment: comments[index % comments.length],
    area: areas[index % areas.length],
    age_group: ages[index % ages.length],
    theme: themes[index % themes.length],
  }));

writeTestData("small-10.csv", csv(["id", "comment", "area", "age_group", "theme"], makeRows(10)));
writeTestData("medium-100.csv", csv(["id", "comment", "area", "age_group", "theme"], makeRows(100)));
writeTestData("large-1000.csv", csv(["id", "comment", "area", "age_group", "theme"], makeRows(1000)));

writeTestData(
  "special-characters.csv",
  csv(
    ["id", "comment", "area", "note"],
    [
      { id: 1, comment: "駅前の案内に「運休・遅延」が表示されると助かります。", area: "中央", note: "鉤括弧" },
      {
        id: 2,
        comment: 'CSV内のカンマ, ダブルクォート"にも対応できるか確認したいです。',
        area: "北部",
        note: "comma and quote",
      },
      {
        id: 3,
        comment: "多言語案内として English, 한국어, 中文 の併記も検討してほしいです。",
        area: "東部",
        note: "multiple languages",
      },
      { id: 4, comment: "改行を含む意見です。\n窓口とWebの両方で案内してほしいです。", area: "西部", note: "newline" },
      { id: 5, comment: "半角記号 !? # % & / と全角記号！？＃％＆の扱いを確認します。", area: "南部", note: "symbols" },
    ],
  ),
);

writeTestData(
  "multiple-attributes.csv",
  csv(
    ["id", "comment", "area", "age_group", "household", "transport", "channel", "priority"],
    Array.from({ length: 24 }, (_, index) => ({
      id: index + 1,
      comment: comments[index % comments.length],
      area: areas[index % areas.length],
      age_group: ages[index % ages.length],
      household: ["単身", "夫婦のみ", "子育て世帯", "三世代"][index % 4],
      transport: ["自家用車", "バス", "鉄道", "徒歩・自転車"][index % 4],
      channel: ["Webフォーム", "紙アンケート", "説明会", "電話"][index % 4],
      priority: ["高", "中", "低"][index % 3],
    })),
  ),
);

writeTestData(
  "invalid/unclosed-quote.csv",
  'id,comment,area\n1,"閉じていない引用符の例,中央\n2,次の行も崩れます,北部\n',
);
writeTestData("invalid/missing-comment-column.csv", "id,body,area\n1,comment列がないCSVです,中央\n");
writeTestData(
  "invalid/inconsistent-columns.csv",
  "id,comment,area\n1,列数が合う行,中央\n2,列が足りない行\n3,列が多すぎる行,東部,extra\n",
);
