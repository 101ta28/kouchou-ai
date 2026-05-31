"use server";

import { getAdminApiHeaders } from "@/app/utils/admin-api-key";
import { getApiBaseUrl } from "@/app/utils/api";

type Provider = "openai" | "azure" | "openrouter" | "gemini" | "local";

type ModelOption = {
  value: string;
  label: string;
};

export async function fetchModelsFromServer(provider: Provider, address?: string): Promise<ModelOption[]> {
  const params = new URLSearchParams({ provider });
  if (provider === "local" && address) {
    params.append("address", address);
  }

  const response = await fetch(`${getApiBaseUrl()}/admin/models?${params.toString()}`, {
    method: "GET",
    headers: await getAdminApiHeaders({
      "Content-Type": "application/json",
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}
