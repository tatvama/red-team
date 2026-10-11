// Access control shared by API routes and src/proxy.ts. No "server-only" import: the proxy runs
// outside the React server environment, where that package throws.
//
// Model: loopback hosts are the single local user and need no sign-in. Any other host must be
// listed in ALLOWED_HOSTS *and* ACCESS_TOKEN must be set; those requests need a signed session
// cookie (from /login) or an `Authorization: Bearer <ACCESS_TOKEN>` header. Everything else is denied.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const SESSION_COOKIE = "tatvam_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function accessConfig() {
  return {
    /** Extra host names (optionally with :port) the app may be reached at, e.g. agent.example.com. */
    allowedHosts: (env("ALLOWED_HOSTS") ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
    accessToken: env("ACCESS_TOKEN"),
    sessionSecret: env("SESSION_SECRET"),
  };
}

export type AccessDecision =
  | { allowed: true; remote: boolean; authenticated: boolean }
  | { allowed: false; status: 401 | 403 };

function requestHost(request: Request): string {
  return (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
}

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return Buffer.from(signature).toString("base64url");
}

/** Compares secrets without leaking their length or content through timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const secret = Buffer.from(key).toString("base64");
  const [left, right] = await Promise.all([hmac(secret, a), hmac(secret, b)]);
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0 && left.length === right.length;
}

function signingSecret(): string | null {
  const { accessToken, sessionSecret } = accessConfig();
  if (sessionSecret) return sessionSecret;
  // Deriving from the token means rotating ACCESS_TOKEN also signs everyone out.
  return accessToken ? `tatvam-session-v1:${accessToken}` : null;
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function tokenMatches(candidate: string): Promise<boolean> {
  const { accessToken } = accessConfig();
  return Boolean(accessToken) && (await safeEqual(candidate, accessToken!));
}

async function sessionValid(request: Request): Promise<boolean> {
  const secret = signingSecret();
  if (!secret) return false;
  const bearer = request.headers.get("authorization");
  if (bearer?.startsWith("Bearer ") && (await tokenMatches(bearer.slice(7).trim()))) return true;
  const cookie = readCookie(request, SESSION_COOKIE);
  const [version, expiry, signature] = cookie?.split(".") ?? [];
  if (version !== "v1" || !expiry || !signature || !/^\d+$/.test(expiry)) return false;
  if (Number(expiry) < Date.now() / 1000) return false;
  return safeEqual(signature, await hmac(secret, `v1.${expiry}`));
}

/**
 * Decides whether a request may proceed. `session: "optional"` lets the login and session
 * endpoints answer an allowed host before the user has signed in.
 */
export async function decideAccess(request: Request, session: "required" | "optional" = "required"): Promise<AccessDecision> {
  const host = requestHost(request);
  const hostname = hostnameOf(host);
  if (!hostname) return { allowed: false, status: 403 };
  const loopback = LOOPBACK.has(hostname);
  const { allowedHosts, accessToken } = accessConfig();
  const listed = allowedHosts.includes(host) || allowedHosts.includes(hostname);
  // The Host check is what defeats DNS rebinding: the attacker's page still sends its own hostname.
  if (!loopback && !(listed && accessToken)) return { allowed: false, status: 403 };

  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return { allowed: false, status: 403 };
    } catch {
      return { allowed: false, status: 403 };
    }
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") return { allowed: false, status: 403 };

  if (loopback) return { allowed: true, remote: false, authenticated: true };
  const authenticated = await sessionValid(request);
  if (authenticated || session === "optional") return { allowed: true, remote: true, authenticated };
  return { allowed: false, status: 401 };
}

function secureFlag(request: Request): string {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return proto === "https" ? "; Secure" : "";
}

export async function sessionCookie(request: Request): Promise<string> {
  const secret = signingSecret();
  if (!secret) throw new Error("ACCESS_TOKEN is not configured");
  const expiry = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const value = `v1.${expiry}.${await hmac(secret, `v1.${expiry}`)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secureFlag(request)}`;
}

export function clearedSessionCookie(request: Request): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag(request)}`;
}
