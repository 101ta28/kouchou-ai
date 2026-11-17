"use client";

import { Box, Flex, Heading, Text } from "@chakra-ui/react";
import type { CountRange, PublicAuditDocument } from "./types";
import { formatDate, kindLabels } from "./types";

const stepLabels: Record<string, string> = {
  extraction: "意見の抽出",
  embedding: "埋め込み",
  opinion_classification: "意見の分類",
  opinion_stance: "賛否の分類",
  opinion_novelty: "意見の新規性",
  hierarchical_clustering: "グループ分け",
  hierarchical_initial_labelling: "グループ名の生成",
  hierarchical_merge_labelling: "グループ名の統合",
  hierarchical_overview: "概要の生成",
  hierarchical_aggregation: "結果の集計",
  hierarchical_visualization: "可視化",
  llm_grouping: "LLMによるグループ分け",
};
const statuses: Record<string, string> = {
  completed: "完了",
  failed: "失敗",
  skipped: "スキップ",
  started: "開始を記録",
  not_recorded: "記録なし",
};
const changeLabels: Record<string, string> = {
  model: "モデル",
  prompts: "プロンプト",
  settings: "設定",
  results: "分析結果",
  labels: "グループ名",
  visibility: "公開範囲",
  visualization: "表示設定",
};
const count = (range: CountRange) =>
  range ? `${range.minimum.toLocaleString()}〜${range.maximum.toLocaleString()}件` : "記録から確認できません";

export function AuditPreviewContent({ document }: { document: PublicAuditDocument }) {
  const rows = [
    ["操作", kindLabels[document.kind] || document.kind],
    ["実行日時", formatDate(document.started_at)],
    ["実行結果", statuses[document.status] || document.status],
    ["プロバイダー", document.provider || "記録なし・公開対象外"],
    ["モデル", document.model || "記録なし・公開対象外"],
    [
      "分析方式",
      document.analysis_mode === "hierarchical"
        ? "階層クラスタリング"
        : document.analysis_mode === "llm_grouping"
          ? "LLMによるグループ分け"
          : "記録なし",
    ],
    ["入力件数", count(document.counts.input_rows)],
    ["抽出意見数", count(document.counts.extracted_arguments)],
  ];
  return (
    <Box>
      <Heading as="h3" textStyle="body/md/bold" mb={3}>
        公開される内容
      </Heading>
      <Box as="dl" borderWidth="1px" borderColor="border.weak" borderRadius="md" overflow="hidden">
        {rows.map(([label, value], index) => (
          <Flex
            key={label}
            px={4}
            py={2}
            gap={{ base: 3, md: 4 }}
            alignItems="baseline"
            bg={index % 2 ? "gray.50" : "white"}
          >
            <Text as="dt" color="gray.600" minW={{ base: "88px", md: "120px" }} flexShrink={0} fontSize="sm">
              {label}
            </Text>
            <Text as="dd" flex="1" minW={0} m={0} overflowWrap="anywhere">
              {value}
            </Text>
          </Flex>
        ))}
      </Box>
      <Text fontSize="sm" color="gray.600" mt={2}>
        件数は10件幅の範囲で表示します。記録なしは0件を意味しません。
      </Text>
      <Box as="details" mt={4}>
        <Box as="summary" cursor="pointer" fontWeight="bold" py={2}>
          処理ごとのモデル・設定・プロンプト
        </Box>
        {document.steps.map((step) => (
          <Box key={step.name} borderTopWidth="1px" borderColor="border.weak" py={3} fontSize="sm">
            <Flex justify="space-between" gap={3} flexWrap="wrap">
              <Text fontWeight="bold">{stepLabels[step.name] || step.name}</Text>
              <Text>{statuses[step.status] || step.status}</Text>
            </Flex>
            <Text mt={1}>モデル: {step.model || "記録なし・公開対象外"}</Text>
            {Object.entries(step.parameters).map(([key, value]) => (
              <Text key={key} overflowWrap="anywhere">
                {key}: {JSON.stringify(value)}
              </Text>
            ))}
            {Object.entries(step.prompts).map(([key, prompt]) => (
              <Text key={key} overflowWrap="anywhere">
                {key}:{" "}
                {prompt.source === "builtin"
                  ? `既定テンプレート（${prompt.template_id}）`
                  : prompt.source === "custom_or_unknown"
                    ? "独自または不明（本文は非公開）"
                    : "記録なし"}
              </Text>
            ))}
          </Box>
        ))}
        {document.steps.length === 0 && <Text fontSize="sm">処理ごとの記録はありません。</Text>}
      </Box>
      {document.comparison_available && (
        <Text fontSize="sm" mt={3}>
          変更された項目: {document.changed_sections.map((key) => changeLabels[key] || key).join("、") || "変更なし"}
        </Text>
      )}
      <Box bg="blue.50" p={4} borderRadius="md" mt={4} fontSize="sm">
        <Text fontWeight="bold" mb={1}>
          元コメント・意見本文・プロンプト本文は含みません
        </Text>
        <Text>
          この実行時点の記録を公開します。その後の編集内容や現在のレポートとの一致、分析の正確性・公平性を保証するものではありません。
        </Text>
      </Box>
      <Box as="details" mt={3}>
        <Box as="summary" cursor="pointer" py={2} fontSize="sm">
          公開されるJSONをすべて確認
        </Box>
        <Box
          as="pre"
          bg="gray.50"
          p={4}
          maxH="320px"
          overflow="auto"
          whiteSpace="pre-wrap"
          overflowWrap="anywhere"
          fontSize="xs"
          tabIndex={0}
          aria-label="公開監査資料のJSON"
        >
          {JSON.stringify(document, null, 2)}
        </Box>
      </Box>
    </Box>
  );
}
