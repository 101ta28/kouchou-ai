"use client";

import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseBrowserEnv } from "./env";

export function createClient() {
  const { supabaseUrl, supabaseKey } = getSupabaseBrowserEnv();
  return createBrowserClient(supabaseUrl, supabaseKey);
}
