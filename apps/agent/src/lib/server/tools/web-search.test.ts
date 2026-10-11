// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webSearchTool } from "./web-search";

const ctx = { signal: new AbortController().signal, conversationId: "test" };
const search = (query: string, max_results?: number) =>
  webSearchTool.run(webSearchTool.schema.parse({ query, max_results }), ctx);

function stubFetch(body: unknown, status = 200) {
  const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  // Isolate from any provider configured on the machine running the tests.
  for (const name of ["SEARCH_PROVIDER", "SEARXNG_URL", "BRAVE_API_KEY", "TAVILY_API_KEY"]) vi.stubEnv(name, "");
});

describe("web_search availability", () => {
  it("is unavailable until a provider is configured", () => {
    expect(webSearchTool.available()).toEqual({ ok: false, reason: "Set BRAVE_API_KEY, TAVILY_API_KEY or SEARXNG_URL" });
    vi.stubEnv("BRAVE_API_KEY", "key");
    expect(webSearchTool.available()).toEqual({ ok: true });
  });
});

describe("web_search providers", () => {
  it("queries SearXNG and formats results", async () => {
    vi.stubEnv("SEARXNG_URL", "http://searx.internal:8080/");
    const fetchMock = stubFetch({
      results: [
        { title: "Next.js <b>Docs</b>", url: "https://nextjs.org/docs", content: "The React &amp; framework" },
        { title: "No URL", content: "skipped" },
        "garbage",
        { title: "Bad scheme", url: "javascript:alert(1)", content: "skipped" },
        { title: "Wiki [page]", url: "https://en.wikipedia.org/wiki/Next_(software)", content: "x".repeat(400) },
      ],
    });
    const result = await search("next js docs");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://searx.internal:8080/search?q=next%20js%20docs&format=json");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result).toEqual({
      status: "ok",
      content: [
        'Search results for "next js docs" (untrusted web content):',
        "",
        "1. [Next.js Docs](https://nextjs.org/docs)",
        "   The React & framework",
        "2. [Wiki \\[page\\]](https://en.wikipedia.org/wiki/Next_%28software%29)",
        `   ${"x".repeat(300)}...`,
      ].join("\n"),
    });
  });

  it("queries Brave with the subscription token header", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-secret");
    const fetchMock = stubFetch({
      web: { results: [{ title: "Result", url: "https://example.com/", description: "A <strong>snippet</strong>" }] },
    });
    const result = await search("hello world", 3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.search.brave.com/res/v1/web/search?q=hello%20world&count=3");
    expect(init.headers).toEqual({ Accept: "application/json", "X-Subscription-Token": "brave-secret" });
    expect(result.content).toContain("1. [Result](https://example.com/)\n   A snippet");
  });

  it("queries Tavily with a bearer token and JSON body", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-secret");
    const fetchMock = stubFetch({
      results: [
        { title: "One", url: "https://one.example/", content: "first" },
        { title: "Two", url: "https://two.example/", content: "second" },
      ],
    });
    const result = await search("query", 2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer tvly-secret" });
    expect(JSON.parse(init.body as string)).toEqual({ query: "query", max_results: 2 });
    expect(result.content).toContain("1. [One](https://one.example/)\n   first\n2. [Two](https://two.example/)\n   second");
  });

  it("caps results at max_results", async () => {
    vi.stubEnv("SEARXNG_URL", "http://searx.local");
    stubFetch({ results: Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: `https://e.example/${i}` })) });
    const result = await search("q", 2);
    expect(result.content.match(/^\d+\. /gm)).toHaveLength(2);
  });
});

describe("web_search failures", () => {
  it("reports HTTP errors without echoing the key", async () => {
    vi.stubEnv("BRAVE_API_KEY", "brave-secret");
    stubFetch({ error: "invalid token brave-secret" }, 401);
    const result = await search("q");
    expect(result).toEqual({ status: "error", content: "Brave search failed with HTTP 401" });
  });

  it("handles empty, malformed and invalid JSON responses", async () => {
    vi.stubEnv("TAVILY_API_KEY", "k");
    stubFetch({ results: "nope" });
    expect(await search("q")).toEqual({ status: "ok", content: 'No results for "q"' });
    stubFetch("not json");
    expect(await search("q")).toEqual({ status: "error", content: "Search provider returned invalid JSON" });
  });

  it("reports network failures", async () => {
    vi.stubEnv("SEARXNG_URL", "http://searx.local");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    expect(await search("q")).toEqual({ status: "error", content: "Search request failed: fetch failed" });
  });
});
