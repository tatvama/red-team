import { loginSchema } from "@/lib/contract";
import { accessConfig, sessionCookie, tokenMatches } from "@/lib/server/auth";
import { failure, guard, readJson } from "@/lib/server/http";

export const runtime = "nodejs";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const store = globalThis as unknown as { tatvamLoginFailures?: Map<string, { count: number; resetAt: number }> };
const failures = (store.tatvamLoginFailures ??= new Map());

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "direct";
}

export async function POST(request: Request) {
  const denied = await guard(request, "optional");
  if (denied) return denied;
  if (!accessConfig().accessToken) return failure("Sign-in is not configured on this server.", 404);

  const key = clientKey(request);
  const now = Date.now();
  const record = failures.get(key);
  if (record && record.resetAt > now && record.count >= MAX_FAILURES)
    return failure("Too many attempts. Wait a few minutes.", 429);

  let parsed;
  try {
    parsed = loginSchema.safeParse(await readJson(request, 2_000));
  } catch {
    return failure("Send an access token.", 400);
  }
  if (!parsed.success) return failure("Send an access token.", 400);

  if (!(await tokenMatches(parsed.data.token))) {
    const fresh = !record || record.resetAt <= now;
    failures.set(key, { count: fresh ? 1 : record.count + 1, resetAt: fresh ? now + WINDOW_MS : record.resetAt });
    return failure("That token is not correct.", 401);
  }
  failures.delete(key);
  return new Response(null, {
    status: 204,
    headers: { "Set-Cookie": await sessionCookie(request), "Cache-Control": "no-store" },
  });
}
