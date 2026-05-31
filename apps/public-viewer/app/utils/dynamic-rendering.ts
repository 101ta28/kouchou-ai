import { connection } from "next/server";
import { isStaticExportBuild } from "./static-build";
import { isAuthEnabled } from "./supabase/env";

export async function ensureRequestBoundRendering() {
  if (isAuthEnabled() && !isStaticExportBuild()) {
    await connection();
  }
}
