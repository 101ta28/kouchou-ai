export function isAuthEnabled() {
  return process.env.AUTH_ENABLED === "true" || process.env.NEXT_PUBLIC_AUTH_ENABLED === "true";
}

export function getSupabaseBrowserEnv() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables are not configured");
  }

  return { supabaseUrl, supabaseKey };
}
