import { isSampleSiteEnabled, sampleResults } from "@/app/sample-site/data";
import { getApiBaseUrl } from "@/app/utils/api";
import { getClusterNum } from "@/app/utils/cluster-num";
import type { Result } from "@/type";
import { ImageResponse } from "next/og";

export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

// フォントキャッシュ
const fontCache: Record<number, Promise<ArrayBuffer> | null> = {};

async function fetchFont(weight: number) {
  // キャッシュにフォントがあれば再利用
  if (fontCache[weight]) {
    return fontCache[weight];
  }

  // キャッシュにない場合は取得してキャッシュに保存
  const fontPromise = (async () => {
    const fontData = await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}`).then((res) =>
      res.text(),
    );
    const fontUrl = fontData.match(/url\((.*?)\)/)?.[1];
    if (!fontUrl) throw new Error("Failed to load font");
    return fetch(fontUrl).then((res) => res.arrayBuffer());
  })();

  // キャッシュに保存
  fontCache[weight] = fontPromise;

  return fontPromise;
}

// 多数のAPIリクエストをリトライする関数
async function fetchApiWithRetry(url: string, options: RequestInit, retries = 5, delay = 1000): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      console.warn(`API fetch failed with status ${response.status} for ${url}. Attempt ${i + 1}/${retries + 1}.`);
      if (i < retries && (response.status >= 500 || response.status === 408)) {
        // Retry on 5xx or Request Timeout 408
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Retry
      }
      // 回復可能な状態でも最後の試行でもない場合は、エラーを投げる。
      throw new Error(`API fetch failed with status ${response.status}`);
    } catch (error: unknown) {
      console.warn(
        `API fetch error for ${url}: ${error instanceof Error ? error.message : String(error)}. Attempt ${i + 1}/${retries + 1}.`,
      );
      // ネットワークエラー時のリトライ (TypeError from fetch)
      if (i < retries) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue; // Retry
      }
      // If last attempt, re-throw the error
      throw error;
    }
  }
  // Should not reach here if loop conditions are correct, but good practice
  throw new Error(`API fetch failed after ${retries + 1} attempts for ${url}`);
}

export const OpImage = async (slug: string) => {
  const sampleMode = isSampleSiteEnabled();
  const result = sampleMode
    ? sampleResults[slug]
    : await fetchApiWithRetry(`${getApiBaseUrl()}/reports/${slug}`, {
        headers: {
          "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
          "Content-Type": "application/json",
        },
      }).then((response) => response.json() as Promise<Result>);

  if (!result) {
    throw new Error(`Report not found: ${slug}`);
  }

  if (sampleMode) {
    return new ImageResponse(
      <div
        style={{
          background: "linear-gradient(to right, #f9c8a0, #f7c5da)",
          width: "100%",
          height: "100%",
          padding: "64px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ fontSize: 64, fontWeight: 700 }}>Kouchou AI Sample Report</div>
        <div style={{ fontSize: 36, fontWeight: 400 }}>{slug}</div>
      </div>,
      size,
    );
  }

  const fonts = sampleMode
    ? []
    : await Promise.all([fetchFont(400), fetchFont(700)]).then(([font400, font700]) => [
        {
          name: "Noto Sans JP",
          data: font400,
          style: "normal" as const,
          weight: 400 as const,
        },
        {
          name: "Noto Sans JP",
          data: font700,
          style: "normal" as const,
          weight: 700 as const,
        },
      ]);

  const clusterNum = getClusterNum(result);
  const pageTitle = result.config.question;

  return new ImageResponse(
    <div
      style={{
        background: "linear-gradient(to right, #f9c8a0, #f7c5da)",
        width: "100%",
        height: "100%",
        padding: "2rem",
        display: "flex",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          height: "100%",
          width: "100%",
          background: "white",
          padding: "2rem 3.5rem 2.8rem",
          borderRadius: "10px",
          boxSizing: "border-box",
        }}
      >
        <Header pageTitle={pageTitle} />
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <Stats result={result} clusterNum={clusterNum} />
          <Footer />
        </div>
      </div>
    </div>,
    {
      ...size,
      ...(fonts.length > 0 ? { fonts } : {}),
    },
  );
};

function Header({ pageTitle }: { pageTitle: string }) {
  return (
    <div
      style={{
        display: "-webkit-box",
        overflow: "hidden",
        fontSize: 64,
        fontWeight: "bold",
        lineHeight: "1.4",
      }}
    >
      {pageTitle}
    </div>
  );
}

function Footer() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignSelf: "flex-end",
        textAlign: "end",
        fontWeight: "700",
        lineHeight: "1.2",
      }}
    >
      <div style={{ fontSize: 50, alignSelf: "flex-end", marginBottom: "0.3rem" }}>広聴AI</div>
      <div style={{ fontSize: 30, alignSelf: "flex-end" }}>デジタル民主主義2030</div>
      <div style={{ fontSize: 30, alignSelf: "flex-end" }}>ブロードリスニング</div>
    </div>
  );
}

function Stats({
  result,
  clusterNum,
}: {
  result: Result;
  clusterNum: Record<number, number>;
}) {
  const level1ClusterNum = clusterNum[1] ?? 0;
  const level2ClusterNum = clusterNum[2];
  return (
    <div
      style={{
        display: "flex",
        fontSize: 34,
        gap: "3rem",
        marginTop: "auto",
        fontWeight: "400",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {/* https://lucide.dev/icons/message-circle-warning */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="コメント数"
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            className="lucide lucide-message-circle-warning"
          >
            <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
            <path d="M12 8v4" />
            <path d="M12 16h.01" />
          </svg>
          <div style={{ fontWeight: "400" }}>{result.comment_num.toLocaleString()}</div>
        </div>
        <div style={{ fontSize: 18, marginLeft: "36px" }}>コメント数</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {/* https://lucide.dev/icons/messages-square */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="抽出した議論数"
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            className="lucide lucide-messages-square"
          >
            <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
            <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
          </svg>
          <div>{result.arguments.length.toLocaleString()}</div>
        </div>
        <div style={{ fontSize: 18, marginLeft: "38px" }}>抽出した議論数</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {/* https://lucide.dev/icons/clipboard-check */}
          <svg
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="集約した意見グループ数"
            width="30"
            height="30"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            className="lucide lucide-clipboard-check"
          >
            <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
            <path d="m9 14 2 2 4-4" />
          </svg>
          <div style={{ display: "flex" }}>
            {level1ClusterNum.toLocaleString()}
            {level2ClusterNum !== undefined ? `→${level2ClusterNum.toLocaleString()}` : ""}
          </div>
        </div>
        <div style={{ fontSize: 18, marginLeft: "40px" }}>集約した意見グループ数</div>
      </div>
    </div>
  );
}
