import { NextResponse, type NextRequest } from "next/server";
import { decideAccess } from "@/lib/server/auth";

// Guards pages. API routes run the same check themselves (guard() in http.ts) so they can answer
// with JSON instead of a redirect.
export async function proxy(request: NextRequest) {
  const decision = await decideAccess(request);
  if (decision.allowed) return NextResponse.next();
  if (decision.status === 401) return new NextResponse(null, { status: 307, headers: { Location: "/login" } });
  return new NextResponse("This address is not allowed to use Tatvam.", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  matcher: ["/((?!api/|_next/static|_next/image|login|icon.svg|favicon.ico).*)"],
};
