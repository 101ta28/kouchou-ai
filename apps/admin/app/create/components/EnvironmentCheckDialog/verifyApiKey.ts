"use server";

import { getAdminApiHeaders } from "@/app/utils/admin-api-key";
import { getApiBaseUrl } from "@/app/utils/api";

type ErrorType = "authentication_error" | "insufficient_quota" | "rate_limit_error" | "unknown_error";

type VerificationResult = {
  success: boolean;
  message: string;
  available_models?: string[];
  error_type?: ErrorType;
  error_detail?: string;
};

export const verifyApiKey = async (provider: string, userApiKey?: string) => {
  try {
    const headers = await getAdminApiHeaders({
      "Content-Type": "application/json",
    });

    if (userApiKey) {
      headers["x-user-api-key"] = userApiKey;
    }

    const response = await fetch(`${getApiBaseUrl()}/admin/environment/verify?provider=${provider}`, {
      method: "GET",
      headers,
    });

    const result = (await response.json()) as VerificationResult;
    return {
      result,
      error: !!result.error_type,
    };
  } catch (error) {
    console.error("Error verifying API key:", error);
    return {
      result: null,
      error: true,
    };
  }
};

export const verifyChatGptApiKeyWithProvider = async (provider = "openai") => {
  try {
    const response = await fetch(`${getApiBaseUrl()}/admin/environment/verify-chatgpt?provider=${provider}`, {
      method: "GET",
      headers: await getAdminApiHeaders({
        "Content-Type": "application/json",
      }),
    });

    const result = (await response.json()) as VerificationResult;
    return {
      result,
      error: !!result.error_type,
    };
  } catch (error) {
    console.error("Error verifying API key:", error);
    return {
      result: null,
      error: true,
    };
  }
};
