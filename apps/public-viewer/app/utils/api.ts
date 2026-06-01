// サーバー実行時の環境変数を読むため、Next.js の build-time 直値展開を避ける。
const getServerEnv = (key: "API_BASEPATH" | "NEXT_PUBLIC_API_BASEPATH") => process.env[key] || "";

/**
 * 実行環境に応じた適切なAPIのベースURLを取得する
 *
 * クライアントサイドではNEXT_PUBLIC_API_BASEPATHを使用し、
 * サーバーサイドではAPI_BASEPATHが設定されていればそれを使用する
 *
 * @returns APIのベースURL
 */
export const getApiBaseUrl = (): string => {
  // クライアントサイド（ブラウザ環境）の場合
  if (typeof window !== "undefined") {
    return process.env.NEXT_PUBLIC_API_BASEPATH || "";
  }

  // サーバーサイドでAPI_BASEPATHが設定されている場合
  const serverApiBasePath = getServerEnv("API_BASEPATH");
  if (serverApiBasePath) {
    return serverApiBasePath;
  }

  // それ以外の場合はNEXT_PUBLIC_API_BASEPATHを使用
  return getServerEnv("NEXT_PUBLIC_API_BASEPATH");
};

/**
 * APIのベースURLと相対パスから絶対URLを組み立てる
 *
 * @param path API配下の相対パス
 * @returns 組み立てたURL。ベースURLが未設定または不正な場合はnull
 */
export const getApiUrl = (path: string): string | null => {
  const baseUrl = getApiBaseUrl();
  if (!baseUrl) {
    return null;
  }

  try {
    return new URL(path, baseUrl).toString();
  } catch {
    return null;
  }
};
