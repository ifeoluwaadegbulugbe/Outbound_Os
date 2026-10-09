import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth gate: redirects to /login when there's no session cookie.
 * Real authorization happens server-side in requireUser() on every page and
 * action (Next.js guidance: proxy is not a security boundary).
 */
const PUBLIC = ["/login", "/setup", "/r/", "/u/", "/api/email/oauth/", "/api/v1/", "/api/cron/", "/api/ext/", "/api/health"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!req.cookies.get("ob_session")?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\.(?:svg|png|jpg|ico|webp)$).*)"],
};
