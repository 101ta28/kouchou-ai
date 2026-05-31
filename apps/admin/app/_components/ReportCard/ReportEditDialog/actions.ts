"use server";

import { getAdminApiHeaders } from "@/app/utils/admin-api-key";
import { getApiBaseUrl } from "@/app/utils/api";

export async function updateReportConfig(reportSlug: string, formData: FormData) {
  const question = formData.get("question") as string;
  const intro = formData.get("intro") as string;

  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/reports/${reportSlug}/config`, {
      method: "PATCH",
      headers: getAdminApiHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        question,
        intro,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      return { success: false, error: errorData.detail || "メタデータの更新に失敗しました" };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: "メタデータの更新に失敗しました" };
  }
}
