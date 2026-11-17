"use server";

import { getApiBaseUrl } from "@/app/utils/api";
import type { AuditPage, AuditPreview } from "./types";

type Result<T> = { success: true; data: T } | { success: false; error: string };
type Visibility = "public" | "private" | "unlisted";
type PublishResult =
  | { success: true }
  | {
      success: false;
      error: string;
      visibility: Visibility | null;
      reviewRequired: boolean;
    };

class AuditRequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(60000),
    headers: {
      "x-api-key": process.env.NEXT_PUBLIC_ADMIN_API_KEY || "",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new AuditRequestError(response.status, "監査資料の操作に失敗しました。");
  return response;
}

const base = (slug: string) => `/admin/reports/${encodeURIComponent(slug)}/audit`;
const run = (slug: string, id: string) => `${base(slug)}/${encodeURIComponent(id)}`;

export async function fetchAuditRecords(slug: string, offset = 0): Promise<Result<AuditPage>> {
  try {
    const response = await request(`${base(slug)}?limit=50&offset=${offset}`);
    return { success: true, data: await response.json() };
  } catch {
    return {
      success: false,
      error: "監査記録を取得できませんでした。時間をおいて再試行してください。",
    };
  }
}

export async function fetchAuditPreview(slug: string, id: string): Promise<Result<AuditPreview>> {
  try {
    const response = await request(`${run(slug, id)}/public-preview`);
    return { success: true, data: await response.json() };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof AuditRequestError && error.status === 409
          ? "この記録は未完了、または保存ファイルを検証できないため公開できません。別の記録を選ぶか、保存状態を確認してください。"
          : "公開内容を取得できませんでした。再試行してください。",
    };
  }
}

async function currentReport(slug: string): Promise<{ visibility: Visibility; status: string }> {
  const response = await request("/admin/reports");
  const reports = await response.json();
  const report = reports.find((row: { slug: string }) => row.slug === slug);
  if (!report) throw new AuditRequestError(404, "レポートが見つかりません。");
  return report;
}

/** Preflight the reviewed document before changing visibility. Never claim a partial publication succeeded. */
export async function publishReviewedAudit(
  slug: string,
  id: string,
  sha256: string,
  reviewed: boolean,
  publishReport: boolean,
): Promise<PublishResult> {
  if (reviewed !== true || !/^[a-f0-9]{64}$/.test(sha256)) {
    return {
      success: false,
      error: "公開内容を確認し、確認欄にチェックしてください。",
      visibility: null,
      reviewRequired: true,
    };
  }
  let visibility: Visibility | null = null;
  let changedVisibility = false;
  try {
    const report = await currentReport(slug);
    visibility = report.visibility;
    if (report.status !== "ready") throw new AuditRequestError(409, "分析が完了してから公開してください。");
    if (!publishReport && visibility !== "public") {
      throw new AuditRequestError(409, "レポートの公開範囲が変更されました。現在の状態を確認してください。");
    }
    const response = await request(`${run(slug, id)}/public-preview`);
    const preview: AuditPreview = await response.json();
    if (preview.sha256 !== sha256) {
      throw new AuditRequestError(409, "公開内容が変更されました。最新の内容を確認し直してください。");
    }
    if (visibility !== "public") {
      changedVisibility = true;
      await request(`/admin/reports/${encodeURIComponent(slug)}/visibility`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "public" }),
      });
      visibility = "public";
    }
    await request(`${run(slug, id)}/publication`, {
      method: "PUT",
      body: JSON.stringify({ sha256, reviewed: true }),
    });
    return { success: true };
  } catch (error) {
    // A failed PATCH can already have changed visibility. A failed PUT can have
    // completed before the connection was lost; retrying the same digest is idempotent.
    try {
      visibility = (await currentReport(slug)).visibility;
    } catch {
      visibility = null;
    }
    const detail =
      error instanceof AuditRequestError && error.message !== "監査資料の操作に失敗しました。"
        ? error.message
        : error instanceof AuditRequestError && error.status === 409
          ? "公開内容または保存状態が変わりました。最新の内容を確認してください。"
          : "監査資料の公開を確認できませんでした。内容を確認し直して再試行してください。";
    const prefix =
      visibility === null
        ? "現在の公開範囲を確認できません。この画面を閉じ、一覧で公開状態を確認してから開き直してください。"
        : changedVisibility && visibility === "public"
          ? "レポートは公開済みです。"
          : "";
    return {
      success: false,
      error: visibility === null ? prefix : `${prefix}${detail}`,
      visibility,
      reviewRequired: true,
    };
  }
}

export async function withdrawAudit(slug: string, id: string): Promise<Result<null>> {
  try {
    await request(`${run(slug, id)}/publication`, { method: "DELETE" });
    return { success: true, data: null };
  } catch {
    return {
      success: false,
      error: "公開の取り消しを確認できませんでした。状態を再取得してください。",
    };
  }
}
