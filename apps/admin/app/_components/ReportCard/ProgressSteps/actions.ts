"use server";

import { getAdminApiHeaders } from "@/app/utils/admin-api-key";
import { getApiBaseUrl } from "@/app/utils/api";

export type StepJsonResponse = {
  status?: string;
  current_step?: string;
  error_message?: string | null;
  error_log_excerpt?: string | null;
};

type StepStatusResult =
  | {
      success: true;
      data: StepJsonResponse;
    }
  | {
      success: false;
      error: string;
    };

export async function fetchReportStepStatus(slug: string): Promise<StepStatusResult> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/reports/${slug}/status/step-json`, {
      headers: await getAdminApiHeaders({
        "Content-Type": "application/json",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true, data: (await response.json()) as StepJsonResponse };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "レポート生成状況の取得に失敗しました。",
    };
  }
}
