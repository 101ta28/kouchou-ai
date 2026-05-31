export function getReportViewerUrl() {
  return process.env.NEXT_PUBLIC_CLIENT_BASEPATH || process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
}
