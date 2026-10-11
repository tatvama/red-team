import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/fixtures";
import {
  ApiError,
  fetchConversations,
  login,
  restoreCheckpoint,
  runGitAction,
  startAgent,
  updateMcpServer,
} from "./api";
import { navigateTo } from "./navigation";

vi.mock("./navigation", () => ({ navigateTo: vi.fn() }));

const ID = "22222222-2222-4222-8222-222222222222";

describe("api", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.mocked(navigateTo).mockClear();
  });

  it("sends the browser to the sign-in page when a session has expired", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Sign in to continue." }, 401));
    await expect(fetchConversations()).rejects.toMatchObject({ status: 401 });
    expect(navigateTo).toHaveBeenCalledWith("/login");
  });

  it("redirects for a rejected agent stream too", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "Sign in to continue." }, 401));
    await expect(
      startAgent({ provider: "ollama", model: "qwen3", permissionMode: "ask", content: "hi" }, new AbortController().signal),
    ).rejects.toBeInstanceOf(ApiError);
    expect(navigateTo).toHaveBeenCalledWith("/login");
  });

  it("does not redirect when sign-in itself answers 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "That token is not correct." }, 401));
    await expect(login("wrong")).rejects.toMatchObject({ status: 401, message: "That token is not correct." });
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("does not redirect for other errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "The agent is running." }, 409));
    await expect(runGitAction(ID, { action: "push" })).rejects.toMatchObject({
      status: 409,
      message: "The agent is running.",
    });
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it("posts git actions, checkpoint restores and MCP actions as JSON", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ message: "ok", restoredPrompt: null }));
    await runGitAction(ID, { action: "commit", message: "Fix parser" });
    await restoreCheckpoint(ID, { checkpointId: "33333333-3333-4333-8333-333333333333", rewindConversation: true });
    await updateMcpServer("files server", "restart");

    const calls = fetchMock.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))]);
    expect(calls).toEqual([
      [`/api/conversations/${ID}/git`, "POST", { action: "commit", message: "Fix parser" }],
      [
        `/api/conversations/${ID}/checkpoints`,
        "POST",
        { checkpointId: "33333333-3333-4333-8333-333333333333", rewindConversation: true },
      ],
      ["/api/mcp/files%20server", "POST", { action: "restart" }],
    ]);
  });
});
