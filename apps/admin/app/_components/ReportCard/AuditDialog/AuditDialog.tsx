"use client";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DialogBody,
  DialogCloseTrigger,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogRoot,
  DialogTitle,
} from "@/components/ui/dialog";
import { NativeSelectField, NativeSelectRoot } from "@/components/ui/native-select";
import { toaster } from "@/components/ui/toaster";
import type { Report, ReportVisibility } from "@/type";
import { Box, Flex, Spinner, Text } from "@chakra-ui/react";
import { CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { updateReportVisibility } from "../Visibility/actions";
import { AuditPreviewContent } from "./AuditPreview";
import { fetchAuditPreview, fetchAuditRecords, publishReviewedAudit, withdrawAudit } from "./actions";
import { type AuditPreview, type AuditRecord, formatDate, kindLabels } from "./types";

type Props = {
  report: Report;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function AuditDialog({ report, open, onOpenChange }: Props) {
  // A fresh session prevents approvals and delayed responses leaking into the next opening.
  return open ? <AuditDialogSession report={report} onOpenChange={onOpenChange} /> : null;
}

function AuditDialogSession({ report, onOpenChange }: Omit<Props, "open">) {
  const router = useRouter();
  const selectId = useId();
  const [visibility, setVisibility] = useState(report.visibility);
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loadedCount, setLoadedCount] = useState(0);
  const [selectedId, setSelectedId] = useState("");
  const [preview, setPreview] = useState<AuditPreview | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [listError, setListError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [operationError, setOperationError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busyAction, setBusyAction] = useState<"publish" | "report" | "withdraw" | null>(null);
  const busy = busyAction !== null;
  const [visibilityKnown, setVisibilityKnown] = useState(true);
  const [withdrawConfirm, setWithdrawConfirm] = useState(false);
  const [success, setSuccess] = useState("");
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const isPublic = visibility === "public";
  const selected = records.find((record) => record.run_id === selectedId);
  const publication = preview ? preview.publication : selected?.publication;
  const approved = publication?.status === "published";
  const currentApproved = approved && preview?.sha256 === publication.release_id;

  const loadRecords = useCallback(
    async (offset = 0) => {
      setLoadingRecords(true);
      setListError("");
      const result = await fetchAuditRecords(report.slug, offset).catch(() => ({
        success: false as const,
        error: "監査記録を取得できませんでした。再試行してください。",
      }));
      if (!alive.current) return;
      if (result.success) {
        const initial =
          result.data.recommended_record ??
          result.data.records.find((r) => r.kind === "analysis" && r.status === "completed") ??
          result.data.records.find((r) => r.status !== "incomplete");
        const page = [...result.data.records];
        if (offset === 0 && initial && !page.some((row) => row.run_id === initial.run_id)) page.push(initial);
        setLoadedCount(offset + result.data.records.length);
        setRecords((previous) =>
          offset === 0 ? page : [...previous, ...page.filter((r) => !previous.some((p) => p.run_id === r.run_id))],
        );
        setTotal(result.data.total);
        if (offset === 0) {
          setSelectedId(initial?.run_id || "");
        }
      } else setListError(result.error);
      setLoadingRecords(false);
    },
    [report.slug],
  );

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately reloads the same selected record.
  useEffect(() => {
    let active = true;
    setPreview(null);
    setPreviewError("");
    setReviewed(false);
    setWithdrawConfirm(false);
    if (!selectedId) {
      setLoadingPreview(false);
      return;
    }
    setLoadingPreview(true);
    fetchAuditPreview(report.slug, selectedId)
      .catch(() => ({
        success: false as const,
        error: "公開内容を取得できませんでした。再試行してください。",
      }))
      .then((result) => {
        if (!active) return;
        if (result.success) {
          setPreview(result.data);
          setRecords((rows) =>
            rows.map((row) => (row.run_id === selectedId ? { ...row, publication: result.data.publication } : row)),
          );
        } else setPreviewError(result.error);
        setLoadingPreview(false);
      });
    return () => {
      active = false;
    };
  }, [report.slug, selectedId, refresh]);

  async function publish() {
    if (!preview || !reviewed || busy || !visibilityKnown) return;
    setBusyAction("publish");
    setOperationError("");
    try {
      const result = await publishReviewedAudit(report.slug, selectedId, preview.sha256, reviewed, !isPublic);
      if (!alive.current) return;
      router.refresh();
      if (result.success) {
        setVisibility("public" as ReportVisibility);
        setSuccess(isPublic ? "監査資料を公開しました" : "レポートと監査資料を公開しました");
      } else {
        setVisibilityKnown(result.visibility !== null);
        if (result.visibility) setVisibility(result.visibility as ReportVisibility);
        setOperationError(result.error);
        setReviewed(false);
        setRefresh((value) => value + 1);
      }
    } catch {
      setVisibilityKnown(false);
      setOperationError("通信が中断されました。この画面を閉じ、一覧で公開状態を確認してから開き直してください。");
      setReviewed(false);
      setRefresh((value) => value + 1);
      router.refresh();
    } finally {
      if (alive.current) setBusyAction(null);
    }
  }

  async function publishReportOnly() {
    if (busy || !visibilityKnown) return;
    setBusyAction("report");
    setOperationError("");
    try {
      const result = await updateReportVisibility(report.slug, "public" as ReportVisibility);
      router.refresh();
      if (!alive.current) return;
      if (result.success) {
        toaster.create({
          type: "success",
          title: "レポートを公開しました",
          description: "監査資料は「監査資料の確認・公開」から後で公開できます。",
        });
        onOpenChange(false);
      } else setOperationError(result.error);
    } catch {
      setOperationError("公開状態を更新できませんでした。レポート一覧で現在の状態を確認してください。");
    } finally {
      if (alive.current) setBusyAction(null);
    }
  }

  async function withdraw() {
    if (busy) return;
    setBusyAction("withdraw");
    setOperationError("");
    try {
      const result = await withdrawAudit(report.slug, selectedId);
      if (!alive.current) return;
      if (result.success) {
        toaster.create({
          type: "success",
          title: "監査資料の公開を取り消しました",
        });
        setRecords((rows) => rows.map((row) => (row.run_id === selectedId ? { ...row, publication: null } : row)));
      } else setOperationError(result.error);
      setRefresh((value) => value + 1);
    } catch {
      setOperationError("公開状態を確認できませんでした。再取得してください。");
    } finally {
      if (alive.current) {
        setBusyAction(null);
        setWithdrawConfirm(false);
      }
    }
  }

  function stateLabel(record: AuditRecord) {
    if (record.publication?.status === "published") return isPublic ? "公開中" : "承認済み";
    if (record.publication?.status === "withdrawn") return "公開取り消し";
    return record.status === "incomplete" ? "未完了" : record.status === "failed" ? "失敗した実行" : "未公開";
  }

  return (
    <DialogRoot
      open
      placement="center"
      size="xl"
      scrollBehavior="inside"
      closeOnInteractOutside={!busy}
      closeOnEscape={!busy}
      onOpenChange={(event) => {
        if (!busy) onOpenChange(event.open);
      }}
    >
      <DialogContent mx={3} maxH="calc(100dvh - 32px)" color="font.primary">
        <DialogCloseTrigger disabled={busy} aria-label="閉じる" />
        <DialogHeader pr={12} flexDirection="column" alignItems="stretch" gap={2}>
          <DialogTitle>{isPublic ? "監査資料の確認・公開" : "レポートを公開"}</DialogTitle>
          <DialogDescription color="gray.600" overflowWrap="anywhere">
            {report.title}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {success ? (
            <Box as="output" display="block" py={8}>
              <Flex align="center" gap={3} color="green.700" mb={3}>
                <CheckCircle2 />
                <Text fontWeight="bold">{success}</Text>
              </Flex>
              <Text>公開レポートの「公開監査資料」からZIPを取得できます。</Text>
              <Text color="gray.600" fontSize="sm" mt={2}>
                実行日時: {preview && formatDate(preview.document.started_at)}
              </Text>
              <Button asChild variant="secondary" size="md" mt={5}>
                <a
                  href={`${process.env.NEXT_PUBLIC_CLIENT_BASEPATH || "http://localhost:3000"}/${encodeURIComponent(report.slug)}#public-audit-title`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  公開レポートを開く
                </a>
              </Button>
            </Box>
          ) : (
            <Flex direction="column" gap={5}>
              <Text>
                {isPublic
                  ? "公開する監査記録を選び、内容を確認してください。"
                  : "レポートと一緒に、分析方法を説明する監査資料を公開できます。公開する内容を確認してください。"}
              </Text>
              {!isPublic && (
                <Text fontSize="sm" color="gray.600">
                  以前に承認した監査資料がある場合は、レポートの公開とともに再び閲覧可能になります。
                </Text>
              )}
              {loadingRecords && records.length === 0 && (
                <Flex as="output" align="center" gap={3}>
                  <Spinner size="sm" />
                  <Text>監査記録を読み込んでいます…</Text>
                </Flex>
              )}
              {listError && (
                <Box role="alert">
                  <Text color="red.700">{listError}</Text>
                  <Button variant="secondary" size="md" mt={3} onClick={() => loadRecords(loadedCount)}>
                    記録を再取得
                  </Button>
                </Box>
              )}
              {!loadingRecords && !listError && records.length === 0 && (
                <Box bg="gray.50" p={4} borderRadius="md">
                  <Text fontWeight="bold">監査記録がありません</Text>
                  <Text mt={2}>
                    この機能の導入前に作成されたレポートなどは、監査資料を生成できません。レポートだけを公開することもできます。
                  </Text>
                </Box>
              )}
              {records.length > 0 && (
                <Box>
                  <Text asChild fontWeight="bold" mb={2}>
                    <label htmlFor={selectId}>公開する記録</label>
                  </Text>
                  <NativeSelectRoot disabled={busy}>
                    <NativeSelectField
                      id={selectId}
                      value={selectedId}
                      onChange={(event) => {
                        setSelectedId(event.target.value);
                        if (visibilityKnown) setOperationError("");
                        setReviewed(false);
                      }}
                    >
                      {!selectedId && <option value="">記録を選択してください</option>}
                      {records.map((record) => (
                        <option key={record.run_id} value={record.run_id} disabled={record.status === "incomplete"}>
                          {formatDate(record.started_at)} · {kindLabels[record.kind] || record.kind} ·{" "}
                          {stateLabel(record)}
                        </option>
                      ))}
                    </NativeSelectField>
                  </NativeSelectRoot>
                  <Text fontSize="sm" color="gray.600" mt={2}>
                    最初に最新の完了した分析を選択します。編集・翻訳や過去の記録も選べます。
                  </Text>
                  {loadedCount < total && (
                    <Button
                      variant="ghost"
                      size="md"
                      mt={2}
                      loading={loadingRecords}
                      disabled={busy}
                      onClick={() => loadRecords(loadedCount)}
                    >
                      以前の記録を読み込む（{loadedCount} / {total}件）
                    </Button>
                  )}
                </Box>
              )}
              {loadingPreview && (
                <Flex as="output" gap={3} align="center">
                  <Spinner size="sm" />
                  <Text>公開内容を準備しています…</Text>
                </Flex>
              )}
              {previewError && (
                <Box role="alert">
                  <Text color="red.700">{previewError}</Text>
                  <Button variant="secondary" size="md" mt={3} onClick={() => setRefresh((value) => value + 1)}>
                    公開内容を再取得
                  </Button>
                </Box>
              )}
              {preview && (
                <>
                  {approved && (
                    <Box bg="green.50" p={4} borderRadius="md">
                      <Text fontWeight="bold">
                        {isPublic
                          ? currentApproved
                            ? "この監査資料は公開中です"
                            : "この記録の以前の版が公開中です"
                          : "この記録には承認済みの監査資料があります"}
                      </Text>
                      <Text fontSize="sm" mt={1}>
                        {isPublic ? "" : "レポートを公開すると、承認済みの資料も閲覧可能になります。"}
                        承認日時: {publication && formatDate(publication.updated_at)}
                      </Text>
                    </Box>
                  )}
                  <AuditPreviewContent document={preview.document} />
                  {!(isPublic && currentApproved) && (
                    <Checkbox
                      checked={reviewed}
                      disabled={busy}
                      onCheckedChange={(event) => setReviewed(event.checked === true)}
                      alignItems="start"
                    >
                      <Text fontWeight="bold">上記の公開内容を確認しました</Text>
                    </Checkbox>
                  )}
                </>
              )}
              {approved && (
                <Box borderTopWidth="1px" borderColor="border.weak" pt={4}>
                  {withdrawConfirm ? (
                    <>
                      <Text>
                        この監査資料の公開を取り消します。取得済みのZIPは回収できません。レポート本文の公開範囲は変わりません。
                      </Text>
                      <Flex gap={3} mt={3}>
                        <Button variant="secondary" size="md" disabled={busy} onClick={() => setWithdrawConfirm(false)}>
                          戻る
                        </Button>
                        <Button size="md" loading={busyAction === "withdraw"} onClick={withdraw}>
                          公開を取り消す
                        </Button>
                      </Flex>
                    </>
                  ) : (
                    <Button variant="ghost" size="md" disabled={busy} onClick={() => setWithdrawConfirm(true)}>
                      この監査資料の公開を取り消す
                    </Button>
                  )}
                </Box>
              )}
            </Flex>
          )}
        </DialogBody>
        <DialogFooter flexWrap="wrap" gap={3} borderTopWidth="1px" borderColor="border.weak">
          {operationError && (
            <Text role="alert" color="red.700" bg="red.50" p={3} borderRadius="md" width="100%" fontSize="sm">
              {operationError}
            </Text>
          )}
          {success ? (
            <>
              <Button
                variant="secondary"
                size="md"
                onClick={() => {
                  setSuccess("");
                  setRefresh((value) => value + 1);
                  void loadRecords();
                }}
              >
                別の記録を確認
              </Button>
              <Button size="md" onClick={() => onOpenChange(false)}>
                完了
              </Button>
            </>
          ) : (
            <>
              {!isPublic && (
                <Button
                  variant="ghost"
                  size="md"
                  disabled={busy || !visibilityKnown}
                  loading={busyAction === "report"}
                  onClick={publishReportOnly}
                >
                  レポートのみ公開
                </Button>
              )}
              <Button variant="secondary" size="md" disabled={busy} onClick={() => onOpenChange(false)}>
                {isPublic ? "閉じる" : "キャンセル"}
              </Button>
              {!(isPublic && currentApproved) && (
                <Button
                  size="md"
                  loading={busyAction === "publish"}
                  disabled={
                    !preview ||
                    !reviewed ||
                    busy ||
                    loadingPreview ||
                    !!listError ||
                    !visibilityKnown ||
                    withdrawConfirm
                  }
                  onClick={publish}
                  whiteSpace="normal"
                  height="auto"
                  minH="44px"
                  py={2}
                >
                  {isPublic ? "監査資料を公開" : "レポートと監査資料を公開"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
