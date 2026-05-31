import { renderHook, waitFor } from "@testing-library/react";
import { fetchReportStepStatus } from "./actions";
import { useReportProgressPoll } from "./useReportProgressPolling";

jest.mock("./actions", () => ({
  fetchReportStepStatus: jest.fn(),
}));

jest.useFakeTimers();

describe("useReportProgressPoll", () => {
  const mockFetchReportStepStatus = fetchReportStepStatus as jest.MockedFunction<typeof fetchReportStepStatus>;
  const original = console.error;

  beforeAll(() => {
    console.error = jest.fn();
  });

  beforeEach(() => {
    mockFetchReportStepStatus.mockClear();
    jest.clearAllTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.useFakeTimers();
    jest.resetAllMocks();
  });

  afterAll(() => {
    console.error = original;
  });

  it("初期状態でloadingが設定される", () => {
    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    expect(result.current.progress).toBe("loading");
  });

  it("指定されたslugで進捗取得が行われる", async () => {
    mockFetchReportStepStatus.mockResolvedValueOnce({ success: true, data: { current_step: "completed" } });

    renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledWith("test-slug");
    });
  });

  it("APIからcurrent_stepが返された時にprogressが更新される", async () => {
    mockFetchReportStepStatus.mockResolvedValueOnce({ success: true, data: { current_step: "extraction" } });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(result.current.progress).toBe("extraction");
    });
  });

  it("current_stepがcompletedの時にポーリングが停止される", async () => {
    mockFetchReportStepStatus.mockResolvedValueOnce({ success: true, data: { current_step: "completed" } });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(result.current.progress).toBe("completed");
    });

    jest.runAllTimers();

    expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(1);
  });

  it("current_stepがerrorの時にprogressがerrorに設定される", async () => {
    mockFetchReportStepStatus.mockResolvedValueOnce({
      success: true,
      data: {
        current_step: "error",
        status: "error",
        error_message: "Step failed",
        error_log_excerpt: "trace line",
      },
    });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(result.current.progress).toBe("error");
      expect(result.current.isError).toBe(true);
      expect(result.current.errorMessage).toBe("Step failed");
      expect(result.current.errorLogExcerpt).toBe("trace line");
    });
  });

  it("current_stepがloadingまたはnullの時にポーリングが継続される", async () => {
    mockFetchReportStepStatus
      .mockResolvedValueOnce({ success: true, data: { current_step: "loading" } })
      .mockResolvedValueOnce({ success: true, data: { current_step: "extraction" } });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(1);
    });

    jest.advanceTimersByTime(3000);

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(2);
      expect(result.current.progress).toBe("extraction");
    });
  });

  it("失敗したリクエストがmaxRetriesまでリトライされる", async () => {
    mockFetchReportStepStatus
      .mockRejectedValueOnce(new Error("Network error"))
      .mockRejectedValueOnce(new Error("Network error"))
      .mockResolvedValueOnce({ success: true, data: { current_step: "extraction" } });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(1);
    });

    jest.advanceTimersByTime(5000);

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(2);
    });

    jest.advanceTimersByTime(5000);

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(3);
      expect(result.current.progress).toBe("extraction");
    });
  });

  it("最大リトライ回数後にエラーが設定される", async () => {
    for (let i = 0; i < 11; i++) {
      mockFetchReportStepStatus.mockResolvedValueOnce({ success: false, error: "HTTP 500" });
    }

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(5000);
      await waitFor(() => {});
    }

    await waitFor(() => {
      expect(result.current.progress).toBe("loading");
      expect(result.current.isError).toBe(true);
      expect(result.current.errorMessage).toBe("レポート生成状況の取得に失敗しました。");
    });
  });

  it("例外による最大リトライ回数後にエラーが設定される", async () => {
    for (let i = 0; i < 11; i++) {
      mockFetchReportStepStatus.mockRejectedValueOnce(new Error("Network error"));
    }

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    for (let i = 0; i < 10; i++) {
      jest.advanceTimersByTime(5000);
      await waitFor(() => {});
    }

    await waitFor(() => {
      expect(result.current.progress).toBe("loading");
      expect(result.current.isError).toBe(true);
      expect(result.current.errorMessage).toBe("レポート生成状況の取得に失敗しました。");
    });
  });

  it("HTTPエラーレスポンスがリトライロジックで処理される", async () => {
    mockFetchReportStepStatus
      .mockResolvedValueOnce({ success: false, error: "HTTP 500" })
      .mockResolvedValueOnce({ success: false, error: "HTTP 500" })
      .mockResolvedValueOnce({ success: true, data: { current_step: "extraction" } });

    const { result } = renderHook(() => useReportProgressPoll("test-slug"));

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(1);
    });

    jest.advanceTimersByTime(2000);
    await Promise.resolve();

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(2);
    });

    jest.advanceTimersByTime(2000);
    await Promise.resolve();

    await waitFor(() => {
      expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(3);
      expect(result.current.progress).toBe("extraction");
    });
  });

  it("アンマウント時にクリーンアップが行われる", async () => {
    mockFetchReportStepStatus.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve({ success: true, data: { current_step: "extraction" } });
          }, 1000);
        }),
    );

    const { unmount } = renderHook(() => useReportProgressPoll("test-slug"));

    unmount();
    jest.advanceTimersByTime(5000);

    expect(mockFetchReportStepStatus).toHaveBeenCalledTimes(1);
  });
});
