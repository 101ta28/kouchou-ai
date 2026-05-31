import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { getSupabaseBrowserEnv } from "./env";

const RETURN_TO_COOKIE = "kouchou-auth-return-to";

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });
  const { supabaseUrl, supabaseKey } = getSupabaseBrowserEnv();

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isLoginPath = request.nextUrl.pathname.startsWith("/login");
  if (!user && !isLoginPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";

    const redirectResponse = NextResponse.redirect(url);
    redirectResponse.cookies.set(RETURN_TO_COOKIE, request.nextUrl.pathname + request.nextUrl.search, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 60 * 10,
    });
    return redirectResponse;
  }

  if (user && isLoginPath) {
    const url = request.nextUrl.clone();
    url.pathname = request.cookies.get(RETURN_TO_COOKIE)?.value || "/";
    url.search = "";

    const redirectResponse = NextResponse.redirect(url);
    redirectResponse.cookies.delete(RETURN_TO_COOKIE);
    return redirectResponse;
  }

  return response;
}
