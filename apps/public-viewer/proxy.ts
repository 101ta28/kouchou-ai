import { type NextRequest, NextResponse } from "next/server";
import { isAuthEnabled } from "./app/utils/supabase/env";
import { updateSession } from "./app/utils/supabase/middleware";

export async function proxy(request: NextRequest) {
  if (!isAuthEnabled()) {
    return NextResponse.next();
  }

  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|images|meta|api/revalidate|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
