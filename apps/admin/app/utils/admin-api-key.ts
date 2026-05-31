import { isAuthEnabled } from "./supabase/env";
import { getAuthorizationHeader } from "./supabase/server";

export function getAdminApiKey(): string {
  return process.env.ADMIN_API_KEY || process.env.NEXT_PUBLIC_ADMIN_API_KEY || "";
}

export async function getAdminApiHeaders(headers: Record<string, string> = {}): Promise<Record<string, string>> {
  const authHeaders = isAuthEnabled() ? await getAuthorizationHeader() : {};

  return {
    "x-api-key": getAdminApiKey(),
    ...authHeaders,
    ...headers,
  };
}
