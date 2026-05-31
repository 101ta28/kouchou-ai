export function getAdminApiKey(): string {
  return process.env.ADMIN_API_KEY || process.env.NEXT_PUBLIC_ADMIN_API_KEY || "";
}

export function getAdminApiHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": getAdminApiKey(),
    ...headers,
  };
}
