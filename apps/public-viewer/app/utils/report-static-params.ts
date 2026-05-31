import type { Report } from "@/type";
import { getApiBaseUrl } from "./api";
import { createStaticBuildFetchError, getStaticBuildReportSlugs, isStaticExportBuild } from "./static-build";

export async function getReportStaticParams() {
  let reports: Report[];

  try {
    const response = await fetch(`${getApiBaseUrl()}/reports`, {
      headers: {
        "x-api-key": process.env.NEXT_PUBLIC_PUBLIC_API_KEY || "",
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch reports: ${response.status} ${response.statusText}`);
    }
    reports = await response.json();
  } catch (error) {
    if (isStaticExportBuild()) {
      throw createStaticBuildFetchError(error);
    }

    return [];
  }

  return getStaticBuildReportSlugs(reports);
}
