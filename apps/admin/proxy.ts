import { type NextRequest, NextResponse } from "next/server";
import { isAuthEnabled } from "./app/utils/supabase/env";
import { updateSession } from "./app/utils/supabase/middleware";

export async function proxy(req: NextRequest) {
  if (req.nextUrl.pathname === "/api/healthcheck") {
    return NextResponse.next();
  }

  if (isAuthEnabled()) {
    return updateSession(req);
  }

  if (
    process.env.BASIC_AUTH_USERNAME === undefined ||
    process.env.BASIC_AUTH_PASSWORD === undefined ||
    process.env.BASIC_AUTH_USERNAME === "" ||
    process.env.BASIC_AUTH_PASSWORD === ""
  ) {
    return NextResponse.next();
  }
  const basicAuth = req.headers.get("authorization");
  if (basicAuth) {
    const authValue = basicAuth.split(" ")[1];
    const [username, password] = Buffer.from(authValue, "base64").toString().split(":");
    if (username === process.env.BASIC_AUTH_USERNAME && password === process.env.BASIC_AUTH_PASSWORD) {
      return NextResponse.next();
    }
  }
  return NextResponse.json(
    { error: "Basic Auth Required" },
    {
      headers: { "WWW-Authenticate": 'Basic realm="Secure Area"' },
      status: 401,
    },
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
