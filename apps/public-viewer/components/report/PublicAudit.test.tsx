import "@testing-library/jest-dom";
import { fetchPublicAuditZip, fetchPublicAudits } from "@/app/utils/public-audit";
import { Provider } from "@/components/ui/provider";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicAudit } from "./PublicAudit";

jest.mock("@/app/utils/public-audit", () => ({
  ...jest.requireActual("@/app/utils/public-audit"),
  AUDIT_PAGE_SIZE: 20,
  fetchPublicAudits: jest.fn(),
  fetchPublicAuditZip: jest.fn(),
}));
const list = jest.mocked(fetchPublicAudits);
const row = {
  run_id: `20261117T000000000000Z-${"a".repeat(32)}`,
  release_id: "a".repeat(64),
  archive_sha256: "b".repeat(64),
  archive_bytes: 100,
  started_at: "2026-11-17T00:00:00+00:00",
  finished_at: "2026-11-17T00:01:00+00:00",
  published_at: "2026-11-17T01:00:00+00:00",
  kind: "analysis",
  status: "completed" as const,
};
const show = () =>
  render(
    <Provider>
      <PublicAudit slug="example" reportTitle="監査テスト" />
    </Provider>,
  );
beforeEach(() => {
  jest.clearAllMocks();
});

it("distinguishes an empty publication list from a retryable error", async () => {
  list.mockRejectedValueOnce(new Error("503")).mockResolvedValueOnce({ total: 0, records: [] });
  show();
  expect(await screen.findByRole("alert")).toHaveTextContent("一覧を取得できませんでした");
  expect(screen.queryByText("公開されている監査資料はありません。")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "一覧を再取得" }));
  expect(await screen.findByText("公開されている監査資料はありません。")).toBeInTheDocument();
});

it("shows the selected run, digest and offline tool guide without claiming current-report correspondence", async () => {
  list.mockResolvedValue({ total: 1, records: [row] });
  show();
  expect(await screen.findByRole("button", { name: "監査資料をダウンロード（ZIP）" })).toBeEnabled();
  expect(screen.getByText(row.archive_sha256)).toBeInTheDocument();
  expect(screen.getByText(row.run_id)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "手元で確認する方法・検証ツール" })).toHaveAttribute(
    "href",
    "/audit-tools/guide.html",
  );
  expect(screen.getByText(/現在のレポートとの一致/)).toBeInTheDocument();
});

it("pages through approved records", async () => {
  list
    .mockResolvedValueOnce({
      total: 21,
      records: Array.from({ length: 20 }, (_, i) => ({
        ...row,
        run_id: `${row.run_id.slice(0, -2)}${i.toString().padStart(2, "0")}`,
      })),
    })
    .mockResolvedValueOnce({ total: 21, records: [row] });
  show();
  await screen.findByText("1–20 / 21");
  fireEvent.click(screen.getByRole("button", { name: "次の資料" }));
  await screen.findByText("21–21 / 21");
  expect(list).toHaveBeenLastCalledWith("example", 20, expect.any(AbortSignal));
  expect(screen.getByRole("button", { name: "次の資料" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "前の資料" })).toBeEnabled();
});

it("reports a withdrawn or changed download and lets the user refresh", async () => {
  list.mockResolvedValueOnce({ total: 1, records: [row] }).mockResolvedValueOnce({ total: 0, records: [] });
  jest.mocked(fetchPublicAuditZip).mockRejectedValue(new Error("404"));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "監査資料をダウンロード（ZIP）" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("公開状態や資料が変更された可能性");
  fireEvent.click(screen.getByRole("button", { name: "一覧を再取得" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(await screen.findByText("公開されている監査資料はありません。")).toBeInTheDocument();
});

it("saves the selected archive with a readable report title and execution date", async () => {
  list.mockResolvedValue({ total: 1, records: [{ ...row, started_at: "2026-11-18T10:49:20" }] });
  jest.mocked(fetchPublicAuditZip).mockResolvedValue(new Blob(["archive"]));
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = jest.fn(() => "blob:audit");
  URL.revokeObjectURL = jest.fn();
  let filename = "";
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    filename = this.download;
  });
  try {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "監査資料をダウンロード（ZIP）" }));
    await waitFor(() => expect(filename).toBe("公開監査資料_監査テスト_分析_2026-11-18_10-49-20.zip"));
    await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:audit"), { timeout: 1500 });
  } finally {
    click.mockRestore();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  }
});
