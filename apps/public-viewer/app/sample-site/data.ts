import type { Cluster, Meta, Report, Result } from "@/type";
import { ReportVisibility } from "@/type";
import catalog from "./catalog.json";

export type SampleScenario = {
  slug: string;
  useCase: string;
  audience: string;
  csvPath: string;
  readGuide: string;
};

type CatalogCluster = [
  id: string,
  level: number,
  parent: string,
  label: string,
  takeaway: string,
  value: number,
  density: number,
];
type CatalogComment = [
  comment: string,
  clusterIds: string[],
  x: number,
  y: number,
  attributes?: Record<string, string>,
];
type CatalogScenario = SampleScenario & {
  targetCommentCount?: number;
  question: string;
  intro: string;
  overview: string;
  clusters: CatalogCluster[];
  comments: CatalogComment[];
};

const baseConfig = {
  name: "",
  question: "",
  input: "",
  model: "gpt-4o-mini",
  intro: "",
  output_dir: "",
  previous: undefined,
  is_embedded_at_local: false,
  enable_source_link: false,
  extraction: {
    workers: 3,
    limit: 100,
    properties: [],
    categories: {},
    category_batch_size: 5,
    source_code: "sample-site: bundled report",
    prompt: "コメントから政策検討に関係する意見を抽出する。",
    model: "gpt-4o-mini",
  },
  hierarchical_clustering: {
    cluster_nums: [3, 6],
    source_code: "sample-site: bundled report",
  },
  embedding: {
    model: "text-embedding-3-small",
    source_code: "sample-site: bundled report",
  },
  hierarchical_initial_labelling: {
    workers: 3,
    source_code: "sample-site: bundled report",
    prompt: "近い意見をまとめ、短いラベルと要約を作る。",
    model: "gpt-4o-mini",
  },
  hierarchical_merge_labelling: {
    workers: 3,
    source_code: "sample-site: bundled report",
    prompt: "下位グループを統合し、上位グループのラベルと要約を作る。",
    model: "gpt-4o-mini",
  },
  hierarchical_overview: {
    source_code: "sample-site: bundled report",
    prompt: "意見グループ全体から、政策検討に使える概要を作る。",
    model: "gpt-4o-mini",
  },
  hierarchical_aggregation: {
    hidden_properties: {},
    source_code: "sample-site: bundled report",
  },
  hierarchical_visualization: {
    replacements: {},
    source_code: "sample-site: bundled report",
  },
  plan: [
    { step: "extraction", run: true, reason: "コメントから意見を抽出するため" },
    { step: "embedding", run: true, reason: "意見の類似度を計算するため" },
    { step: "hierarchical_clustering", run: true, reason: "近い意見を階層的にまとめるため" },
    { step: "hierarchical_initial_labelling", run: true, reason: "下位グループにラベルを付けるため" },
    { step: "hierarchical_merge_labelling", run: true, reason: "上位グループにラベルを付けるため" },
    { step: "hierarchical_overview", run: true, reason: "全体の概要を作成するため" },
    { step: "hierarchical_aggregation", run: true, reason: "表示用データを出力するため" },
  ],
  status: "ready",
};

const scenarios = catalog.scenarios as CatalogScenario[];

type ExpandedComment = {
  comment: string;
  clusterIds: string[];
  x: number;
  y: number;
  attributes?: Record<string, string>;
};

const expandComments = (scenario: CatalogScenario): ExpandedComment[] => {
  const targetCount = scenario.targetCommentCount ?? scenario.comments.length;

  return Array.from({ length: targetCount }, (_, index) => {
    const [comment, clusterIds, x, y, attributes] = scenario.comments[index % scenario.comments.length];
    const cycle = Math.floor(index / scenario.comments.length);
    const offset = ((cycle % 9) - 4) * 0.015;

    return {
      comment: cycle === 0 ? comment : `${comment}（同種意見 ${cycle + 1}）`,
      clusterIds,
      x: x + offset,
      y: y - offset,
      attributes,
    };
  });
};

const countClusterValues = (comments: ExpandedComment[]) => {
  const values = new Map<string, number>();
  for (const comment of comments) {
    for (const clusterId of comment.clusterIds) {
      values.set(clusterId, (values.get(clusterId) ?? 0) + 1);
    }
  }
  return values;
};

const toCluster = (
  [id, level, parent, label, takeaway, value, density_rank_percentile]: CatalogCluster,
  values?: Map<string, number>,
): Cluster => ({
  id,
  level,
  parent,
  label,
  takeaway,
  value: values?.get(id) ?? value,
  density_rank_percentile,
});

const createResult = (scenario: CatalogScenario): Result => {
  const comments = expandComments(scenario);
  const clusterValues = countClusterValues(comments);

  return {
    arguments: comments.map(({ comment, clusterIds, x, y, attributes }, index) => ({
      arg_id: `A${index + 1}`,
      argument: comment,
      comment_id: index + 1,
      x,
      y,
      p: 0,
      cluster_ids: clusterIds,
      attributes,
    })),
    clusters: scenario.clusters.map((cluster) => toCluster(cluster, clusterValues)),
    comments: Object.fromEntries(comments.map(({ comment }, index) => [String(index + 1), { comment }])),
    propertyMap: {},
    translations: {},
    overview: scenario.overview,
    config: {
      ...baseConfig,
      name: scenario.question,
      question: scenario.question,
      input: scenario.slug,
      intro: scenario.intro,
      output_dir: scenario.slug,
    },
    comment_num: comments.length,
    visibility: ReportVisibility.PUBLIC,
    visualizationConfig: {
      version: "1",
      enabledCharts: ["scatterAll", "scatterDetail", "treemap", "hierarchyList"],
      defaultChart: "scatterAll",
      chartOrder: ["scatterAll", "scatterDetail", "treemap", "hierarchyList"],
      params: {
        showClusterLabels: true,
      },
    },
  };
};

export const sampleMeta: Meta = catalog.meta;
export const sampleScenarios: SampleScenario[] = scenarios.map(({ slug, useCase, audience, csvPath, readGuide }) => ({
  slug,
  useCase,
  audience,
  csvPath,
  readGuide,
}));
export const sampleResults: Record<string, Result> = Object.fromEntries(
  scenarios.map((scenario) => [scenario.slug, createResult(scenario)]),
);
export const sampleReports: Report[] = sampleScenarios.map((scenario) => {
  const result = sampleResults[scenario.slug];
  return {
    slug: scenario.slug,
    status: "ready",
    title: result.config.question,
    description: `${scenario.useCase}のサンプル。${scenario.readGuide}`,
    isPubcom: false,
    visibility: ReportVisibility.PUBLIC,
    createdAt: "2026-06-07T00:00:00.000Z",
  };
});

export const isSampleSiteEnabled = () => process.env.NEXT_PUBLIC_SAMPLE_SITE === "true";
export const getSampleScenario = (slug: string) => sampleScenarios.find((scenario) => scenario.slug === slug);
