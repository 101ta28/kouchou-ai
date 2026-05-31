"use server";

import { getAdminApiHeaders } from "@/app/utils/admin-api-key";
import { getApiBaseUrl } from "@/app/utils/api";
import type { ClusterResponse } from "@/type";

type FetchClustersResult =
  | {
      success: true;
      clusters: ClusterResponse[];
    }
  | {
      success: false;
      error: string;
    };

export async function fetchClusters(reportSlug: string): Promise<FetchClustersResult> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/reports/${reportSlug}/cluster-labels`, {
      headers: await getAdminApiHeaders(),
    });

    if (!response.ok) {
      return { success: false, error: "クラスタ一覧の取得に失敗しました" };
    }

    const data = await response.json();
    return { success: true, clusters: data.clusters };
  } catch (error) {
    return { success: false, error: "クラスタ一覧の取得に失敗しました" };
  }
}

type UpdateClusterResult = {
  success: boolean;
  error?: string;
};

export async function updateCluster(reportSlug: string, formData: FormData): Promise<UpdateClusterResult> {
  const id = formData.get("id") as string;
  const label = formData.get("label") as string;
  const description = formData.get("description") as string;

  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/reports/${reportSlug}/cluster-label`, {
      method: "PATCH",
      headers: await getAdminApiHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ id, label, description }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      let errorMessage = errorData.detail || "意見グループ情報の更新に失敗しました";
      if (response.status === 400) {
        errorMessage = `入力データが不正です: ${errorMessage}`;
      } else if (response.status === 404) {
        errorMessage = "指定されたレポートの意見グループが見つかりません";
      }
      return { success: false, error: errorMessage };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: "意見グループ情報の更新に失敗しました" };
  }
}
