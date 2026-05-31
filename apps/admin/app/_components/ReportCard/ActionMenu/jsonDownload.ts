"use server";

import { getAdminApiHeaders } from "../../../utils/admin-api-key";
import { getApiBaseUrl } from "../../../utils/api";

type JsonDownloadResult =
  | {
      success: true;
      data: string;
      filename: string;
      contentType: string;
    }
  | {
      success: false;
      error: string;
    };

export async function jsonDownload(slug: string): Promise<JsonDownloadResult> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/reports/${slug}/json`, {
      headers: getAdminApiHeaders({
        "Content-Type": "application/json",
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return {
        success: false,
        error: errorData.detail || "JSON ダウンロードに失敗しました",
      };
    }

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const jsonContent = Buffer.from(arrayBuffer).toString("base64");

    return {
      success: true,
      data: jsonContent,
      filename: `kouchou_${slug}.json`,
      contentType: "application/json",
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "予期しないエラーが発生しました",
    };
  }
}
