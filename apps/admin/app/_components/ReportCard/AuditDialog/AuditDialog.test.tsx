import { Provider } from "@/components/ui/provider";
import { type Report, ReportVisibility } from "@/type";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateReportVisibility } from "../Visibility/actions";
import { AuditDialog } from "./AuditDialog";
import { fetchAuditPreview, fetchAuditRecords, publishReviewedAudit, withdrawAudit } from "./actions";
import type { AuditPreview, AuditRecord } from "./types";

jest.mock("lucide-react", () => ({ CheckCircle2: () => null }));
jest.mock("./actions", () => ({
  fetchAuditRecords: jest.fn(),
  fetchAuditPreview: jest.fn(),
  publishReviewedAudit: jest.fn(),
  withdrawAudit: jest.fn(),
}));
jest.mock("../Visibility/actions", () => ({
  updateReportVisibility: jest.fn(),
}));
jest.mock("@/components/ui/toaster", () => ({
  toaster: { create: jest.fn() },
}));
const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
const report: Report = {
  slug: "example",
  title: "交通についての意見",
  description: "",
  status: "ready",
  visibility: ReportVisibility.PRIVATE,
  isPubcom: false,
  analysis: { commentNum: 23, argumentsNum: 34, clusterNum: 5 },
};
const record: AuditRecord = {
  run_id: "analysis-1",
  kind: "analysis",
  status: "completed",
  started_at: "2026-11-17T13:00:00+00:00",
  finished_at: "2026-11-17T13:10:00+00:00",
  publication: null,
};
const preview: AuditPreview = {
  sha256: "a".repeat(64),
  publication: null,
  document: {
    source_run_id: record.run_id,
    kind: "analysis",
    status: "completed",
    started_at: record.started_at,
    finished_at: record.finished_at || record.started_at,
    provider: "openai",
    model: "gpt-4o-mini",
    analysis_mode: "hierarchical",
    policy_version: "public-audit-v1",
    counts: {
      input_rows: { minimum: 20, maximum: 29 },
      extracted_arguments: { minimum: 30, maximum: 39 },
      linked_input_ids: null,
      unlinked_input_ids: null,
    },
    steps: [],
    changed_sections: [],
    comparison_available: false,
    software: {},
    omitted: [],
    limitations: [],
  },
};
beforeAll(() => {
  // jsdom does not implement PointerEvent, which Chakra dispatches on checkbox blur.
  window.PointerEvent = MouseEvent as typeof PointerEvent;
});
const close = jest.fn();
function open(visibility = ReportVisibility.PRIVATE) {
  return render(
    <Provider>
      <AuditDialog report={{ ...report, visibility }} open onOpenChange={close} />
    </Provider>,
  );
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchAuditRecords).mockResolvedValue({
    success: true,
    data: {
      total: 2,
      records: [{ ...record, run_id: "edit-2", kind: "visibility_edit" }, record],
    },
  });
  jest.mocked(fetchAuditPreview).mockImplementation(async (_slug, id) => ({
    success: true,
    data: {
      ...preview,
      document: { ...preview.document, source_run_id: id },
    },
  }));
  jest.mocked(publishReviewedAudit).mockResolvedValue({ success: true });
});

it("selects the latest completed analysis and requires review before one-click publication", async () => {
  open();
  const button = screen.getByRole("button", {
    name: "レポートと監査資料を公開",
  });
  expect(button).toBeDisabled();
  await screen.findByText("gpt-4o-mini");
  expect(screen.getByLabelText("公開する記録")).toHaveValue("analysis-1");
  expect(screen.getByText("20〜29件")).toBeInTheDocument();
  expect(button).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(button);
  await screen.findByText("レポートと監査資料を公開しました");
  expect(publishReviewedAudit).toHaveBeenCalledWith("example", "analysis-1", preview.sha256, true, true);
  expect(screen.getByRole("link", { name: "公開レポートを開く" })).toHaveAttribute(
    "href",
    "http://localhost:3000/example#public-audit-title",
  );
  expect(close).not.toHaveBeenCalled();
});

it("clears approval when another record is selected", async () => {
  open();
  await screen.findByText("gpt-4o-mini");
  await userEvent.click(screen.getByRole("checkbox"));
  fireEvent.change(screen.getByLabelText("公開する記録"), {
    target: { value: "edit-2" },
  });
  await waitFor(() => expect(fetchAuditPreview).toHaveBeenLastCalledWith("example", "edit-2"));
  expect(await screen.findByRole("checkbox")).not.toBeChecked();
  expect(screen.getByRole("button", { name: "レポートと監査資料を公開" })).toBeDisabled();
});

it("keeps the dialog open after partial failure and retries only the audit after review", async () => {
  jest
    .mocked(publishReviewedAudit)
    .mockResolvedValueOnce({
      success: false,
      error: "レポートは公開済みですが、監査資料の保存に失敗しました。",
      visibility: "public",
      reviewRequired: true,
    })
    .mockResolvedValueOnce({ success: true });
  open();
  await screen.findByText("gpt-4o-mini");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "レポートと監査資料を公開" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("レポートは公開済み");
  expect(await screen.findByRole("checkbox")).not.toBeChecked();
  expect(close).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "監査資料を公開" }));
  await screen.findByText("監査資料を公開しました");
  expect(publishReviewedAudit).toHaveBeenLastCalledWith("example", "analysis-1", preview.sha256, true, false);
});

it("lets an old report with no audit records be published without claiming an audit was published", async () => {
  jest.mocked(fetchAuditRecords).mockResolvedValue({ success: true, data: { total: 0, records: [] } });
  jest.mocked(updateReportVisibility).mockResolvedValue({ success: true, visibility: ReportVisibility.PUBLIC });
  open();
  await screen.findByText("監査記録がありません");
  await userEvent.click(screen.getByRole("button", { name: "レポートのみ公開" }));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(publishReviewedAudit).not.toHaveBeenCalled();
});

it("makes a failed load retryable", async () => {
  jest.mocked(fetchAuditRecords).mockResolvedValueOnce({ success: false, error: "接続できません" });
  open();
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "記録を再取得" }));
  await screen.findByText("gpt-4o-mini");
  expect(fetchAuditRecords).toHaveBeenCalledTimes(2);
});

it("ignores an older preview response arriving after the record selection changed", async () => {
  let resolveFirst!: (value: { success: true; data: AuditPreview }) => void;
  jest.mocked(fetchAuditPreview).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  open();
  await waitFor(() => expect(fetchAuditPreview).toHaveBeenCalledWith("example", "analysis-1"));
  fireEvent.change(screen.getByLabelText("公開する記録"), {
    target: { value: "edit-2" },
  });
  await screen.findByText("gpt-4o-mini");
  await act(async () =>
    resolveFirst({
      success: true,
      data: {
        ...preview,
        document: { ...preview.document, model: "stale-model" },
      },
    }),
  );
  expect(screen.queryByText("stale-model")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "レポートと監査資料を公開" }));
  await waitFor(() =>
    expect(publishReviewedAudit).toHaveBeenCalledWith("example", "edit-2", preview.sha256, true, true),
  );
});

it("shows an approved release and requires a separate confirmation to withdraw it", async () => {
  const publication = {
    status: "published" as const,
    release_id: preview.sha256,
    updated_at: record.started_at,
  };
  jest.mocked(fetchAuditPreview).mockResolvedValue({ success: true, data: { ...preview, publication } });
  jest.mocked(withdrawAudit).mockResolvedValue({ success: true, data: null });
  open(ReportVisibility.PUBLIC);
  await screen.findByText("この監査資料は公開中です");
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "この監査資料の公開を取り消す" }));
  expect(withdrawAudit).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "公開を取り消す" }));
  await waitFor(() => expect(withdrawAudit).toHaveBeenCalledWith("example", "analysis-1"));
});

it("selects an analysis outside the first page without skipping the next history page", async () => {
  const edits = Array.from({ length: 50 }, (_, i) => ({ ...record, run_id: `edit-${i}`, kind: "visibility_edit" }));
  jest
    .mocked(fetchAuditRecords)
    .mockResolvedValueOnce({ success: true, data: { total: 51, records: edits, recommended_record: record } })
    .mockResolvedValueOnce({ success: true, data: { total: 51, records: [record], recommended_record: record } });
  open();
  await screen.findByText("gpt-4o-mini");
  expect(screen.getByLabelText("公開する記録")).toHaveValue(record.run_id);
  await userEvent.click(screen.getByRole("button", { name: /以前の記録を読み込む/ }));
  await waitFor(() => expect(fetchAuditRecords).toHaveBeenLastCalledWith("example", 50));
  await waitFor(() => expect(screen.queryByRole("button", { name: /以前の記録を読み込む/ })).not.toBeInTheDocument());
  expect(screen.getAllByRole("option")).toHaveLength(51);
});

it("blocks retry when the report visibility cannot be recovered after a disconnected publication", async () => {
  jest.mocked(publishReviewedAudit).mockResolvedValueOnce({
    success: false,
    error: "現在の公開範囲を確認できません。",
    visibility: null,
    reviewRequired: true,
  });
  open();
  await screen.findByText("gpt-4o-mini");
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "レポートと監査資料を公開" }));
  await screen.findByRole("alert");
  await userEvent.click(await screen.findByRole("checkbox"));
  expect(screen.getByRole("button", { name: "レポートと監査資料を公開" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "レポートのみ公開" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "キャンセル" })).toBeEnabled();
});
