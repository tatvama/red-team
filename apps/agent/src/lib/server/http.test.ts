// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as session } from "@/app/api/auth/session/route";
import { clearedSessionCookie, decideAccess, sessionCookie } from "./auth";
import { guard } from "./http";

const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
const allowed = async (req: Request) => (await guard(req)) === null;

describe("local access", () => {
  it("allows same-origin requests to loopback hosts", async () => {
    expect(await allowed(request("http://127.0.0.1:3000/api/x", { host: "127.0.0.1:3000" }))).toBe(true);
    expect(await allowed(request("http://localhost:3000/api/x", { origin: "http://localhost:3000" }))).toBe(true);
  });

  it("trusts the Host header when Next rewrites the request URL to localhost in dev", async () => {
    const headers = { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" };
    expect(await allowed(request("http://localhost:3000/api/x", headers))).toBe(true);
  });

  it("rejects public hosts, including DNS-rebinding hostnames", async () => {
    expect(await allowed(request("http://evil.example:3000/api/x"))).toBe(false);
    expect(await allowed(request("http://192.168.1.20:3000/api/x"))).toBe(false);
  });

  it("rejects cross-origin and cross-site browser requests, and other local apps", async () => {
    expect(await allowed(request("http://127.0.0.1:3000/api/x", { origin: "https://evil.example" }))).toBe(false);
    expect(await allowed(request("http://127.0.0.1:3000/api/x", { "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(await allowed(request("http://127.0.0.1:3000/api/x", { host: "evil.example" }))).toBe(false);
    expect(await allowed(request("http://127.0.0.1:3000/api/x", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:4000" }))).toBe(false);
  });
});

describe("remote access", () => {
  const remote = (headers: Record<string, string> = {}) =>
    request("https://agent.example.com/api/x", { host: "agent.example.com", "x-forwarded-proto": "https", ...headers });

  it("stays off unless the host is allow-listed and an access token is set", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    expect((await guard(remote()))?.status).toBe(403);
    vi.stubEnv("ALLOWED_HOSTS", "");
    vi.stubEnv("ACCESS_TOKEN", "a-long-test-token");
    expect((await guard(remote()))?.status).toBe(403);
  });

  it("requires a session on allow-listed hosts and accepts a signed cookie or bearer token", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    vi.stubEnv("ACCESS_TOKEN", "a-long-test-token");
    expect((await guard(remote()))?.status).toBe(401);
    expect(await allowed(remote({ authorization: "Bearer a-long-test-token" }))).toBe(true);
    expect((await guard(remote({ authorization: "Bearer wrong" })))?.status).toBe(401);

    const cookie = await sessionCookie(remote());
    expect(cookie).toMatch(/HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
    const value = cookie.split(";")[0];
    expect(await allowed(remote({ cookie: value }))).toBe(true);
    expect(await allowed(remote({ cookie: value.replace(/.$/, (c) => (c === "A" ? "B" : "A")) }))).toBe(false);
    expect(clearedSessionCookie(remote())).toMatch(/Max-Age=0/);
  });

  it("invalidates sessions when the access token rotates", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    vi.stubEnv("ACCESS_TOKEN", "first-token-value");
    const value = (await sessionCookie(remote())).split(";")[0];
    vi.stubEnv("ACCESS_TOKEN", "second-token-value");
    expect(await allowed(remote({ cookie: value }))).toBe(false);
  });

  it("rejects expired sessions", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    vi.stubEnv("ACCESS_TOKEN", "a-long-test-token");
    const decision = await decideAccess(remote({ cookie: "tatvam_session=v1.1000.abc" }));
    expect(decision).toEqual({ allowed: false, status: 401 });
  });
});

describe("auth routes", () => {
  const remotePost = (body: unknown, ip: string) =>
    new Request("https://agent.example.com/api/auth/login", {
      method: "POST",
      headers: { host: "agent.example.com", "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });

  it("signs in with the right token and rate-limits wrong guesses", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    vi.stubEnv("ACCESS_TOKEN", "a-long-test-token");
    const ok = await login(remotePost({ token: "a-long-test-token" }, "10.0.0.1"));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("set-cookie")).toMatch(/^tatvam_session=v1\./);

    for (let attempt = 0; attempt < 10; attempt++) expect((await login(remotePost({ token: "nope" }, "10.0.0.2"))).status).toBe(401);
    expect((await login(remotePost({ token: "a-long-test-token" }, "10.0.0.2"))).status).toBe(429);
  });

  it("reports whether the visitor is remote and signed in", async () => {
    vi.stubEnv("ALLOWED_HOSTS", "agent.example.com");
    vi.stubEnv("ACCESS_TOKEN", "a-long-test-token");
    const local = await session(request("http://127.0.0.1:3000/api/auth/session"));
    expect(await local.json()).toEqual({ remote: false, authenticated: true });
    const anonymous = await session(request("https://agent.example.com/api/auth/session", { host: "agent.example.com" }));
    expect(await anonymous.json()).toEqual({ remote: true, authenticated: false });
  });

  it("refuses sign-in when no access token is configured", async () => {
    const response = await login(
      new Request("http://127.0.0.1:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "x" }),
      }),
    );
    expect(response.status).toBe(404);
  });
});
