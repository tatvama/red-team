import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, ConversationDetail, FeedbackRequest, FeedbackView, RouterConfig } from "@/lib/contract";
import { conversationDetail, jsonResponse, NOW, routerConfig } from "@/test/fixtures";
import { AgentApp } from "./agent-app";

vi.mock("@/lib/client/navigation", () => ({ navigateTo: vi.fn() }));

const ID = "22222222-2222-4222-8222-222222222222";
const REPLY = "55555555-5555-4555-8555-555555555555";
const PREFERENCES_KEY = "tatvam.preferences.v1";

const finished: ConversationDetail = conversationDetail({
  id: ID,
  messages: [
    { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW },
    {
      id: REPLY,
      role: "assistant",
      content: "Use Number() to parse.",
      reasoning: "",
      toolCalls: [
        {
          id: "call-1",
          name: "read_file",
          title: "Read file",
          arguments: '{"path":"parser.ts"}',
          summary: "Read parser.ts",
          risk: "read",
          status: "ok",
          output: "export const parse = () => 1;",
        },
      ],
      model: "qwen3-big",
      interrupted: false,
      createdAt: NOW,
    },
  ],
});

const awaitingApproval: ConversationDetail = conversationDetail({
  id: ID,
  messages: [
    { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW },
    {
      id: REPLY,
      role: "assistant",
      content: "I will edit the file.",
      reasoning: "",
      toolCalls: [
        {
          id: "call-2",
          name: "edit_file",
          title: "Edit file",
          arguments: '{"path":"parser.ts","old_string":"a","new_string":"b"}',
          summary: "Edit parser.ts",
          risk: "write",
          status: "awaiting_approval",
        },
      ],
      model: "qwen3-big",
      interrupted: false,
      createdAt: NOW,
    },
  ],
});

function ndjson(items: AgentEvent[]): Response {
  const body = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

type Handler = (body: unknown) => Response | Promise<Response>;

type Setup = {
  conversation?: ConversationDetail;
  router?: RouterConfig | null;
  feedback?: Handler;
  training?: Handler;
  agent?: Handler;
  approve?: Handler;
};

describe("AgentApp training loop", () => {
  const fetchMock = vi.fn<typeof fetch>();

  function route({ conversation = finished, router = null, feedback, training, agent, approve }: Setup = {}) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.startsWith("/api/models?provider=ollama"))
        return jsonResponse({ provider: "ollama", state: "ready", models: ["qwen3", "qwen3-big"] });
      if (url.startsWith("/api/models?provider=gpu")) return jsonResponse({ provider: "gpu", state: "unconfigured", models: [] });
      if (url === "/api/conversations") return jsonResponse({ conversations: [] });
      if (url === "/api/router") return router ? jsonResponse(router) : jsonResponse({ error: "Not found" }, 404);
      if (url === `/api/conversations/${ID}`) return jsonResponse(conversation);
      if (url === `/api/conversations/${ID}/changes`) return jsonResponse({ error: "Not found" }, 404);
      if (url === `/api/conversations/${ID}/feedback` && init?.method === "PUT" && feedback) return feedback(body);
      if (url === `/api/conversations/${ID}/training` && init?.method === "PUT" && training) return training(body);
      if (url === "/api/agent" && init?.method === "POST" && agent) return agent(body);
      if (url === "/api/agent/approve" && init?.method === "POST" && approve) return approve(body);
      return jsonResponse({ error: "Not found" }, 404);
    });
  }

  const bodiesTo = (url: string, method: string) =>
    fetchMock.mock.calls
      .filter(([target, init]) => target === url && init?.method === method)
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  /** Echoes the saved entry back the way the server does. */
  const savedFeedback: Handler = (body) => {
    const request = body as FeedbackRequest;
    const empty = request.rating === null && request.correction === null && request.note === null;
    const entry: FeedbackView = { ...request, updatedAt: NOW };
    return jsonResponse({ feedback: empty ? [] : [entry] });
  };

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  async function openConversation() {
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByText("Use Number() to parse.")).toBeInTheDocument();
  }

  it("rates a reply with thumbs up, shows it as active and toggles it off again", async () => {
    route({ feedback: savedFeedback });
    await openConversation();
    const up = screen.getByRole("button", { name: "Good response" });
    expect(up).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(up);
    expect(up).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Bad response" })).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")).toHaveLength(1));
    expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")[0]).toEqual({
      messageId: REPLY,
      toolCallId: null,
      rating: "up",
      correction: null,
      note: null,
    });

    await userEvent.click(up);
    await waitFor(() => expect(up).toHaveAttribute("aria-pressed", "false"));
    expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")[1]).toMatchObject({ rating: null });
  });

  it("reverts a rating and says why when the server refuses it", async () => {
    route({ feedback: () => jsonResponse({ error: "Feedback could not be stored." }, 500) });
    await openConversation();
    const down = screen.getByRole("button", { name: "Bad response" });
    await userEvent.click(down);

    expect(await screen.findByRole("alert")).toHaveTextContent("Feedback could not be stored.");
    expect(down).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps an existing correction when the rating changes", async () => {
    const existing: FeedbackView = {
      messageId: REPLY,
      toolCallId: null,
      rating: null,
      correction: "Use parseInt with a radix.",
      note: "Number() accepts hex",
      updatedAt: NOW,
    };
    route({ conversation: { ...finished, feedback: [existing] }, feedback: savedFeedback });
    await openConversation();
    expect(screen.getByText("Corrected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Bad response" }));
    await waitFor(() => expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")).toHaveLength(1));
    expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")[0]).toEqual({
      messageId: REPLY,
      toolCallId: null,
      rating: "down",
      correction: "Use parseInt with a radix.",
      note: "Number() accepts hex",
    });
  });

  it("saves a better answer and a note from the inline editor", async () => {
    route({ feedback: savedFeedback });
    await openConversation();
    const suggest = screen.getByRole("button", { name: "Suggest a better answer" });
    await userEvent.click(suggest);

    const editor = screen.getByRole("group", { name: "Suggest a better answer" });
    const text = within(editor).getByRole("textbox", { name: "Better answer" });
    expect(text).toHaveValue("Use Number() to parse.");
    expect(text).toHaveFocus();
    // Saving the reply unchanged would teach nothing.
    expect(within(editor).getByRole("button", { name: "Save correction" })).toBeDisabled();

    await userEvent.clear(text);
    await userEvent.type(text, "Use parseInt(value, 10).");
    await userEvent.type(within(editor).getByRole("textbox", { name: /Note/ }), "Number() accepts hex");
    await userEvent.click(within(editor).getByRole("button", { name: "Save correction" }));

    await waitFor(() => expect(screen.queryByRole("group", { name: "Suggest a better answer" })).not.toBeInTheDocument());
    expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")).toEqual([
      { messageId: REPLY, toolCallId: null, rating: null, correction: "Use parseInt(value, 10).", note: "Number() accepts hex" },
    ]);
    expect(screen.getByText("Corrected")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit correction" })).toHaveFocus());
  });

  it("keeps the editor and the text when a correction cannot be saved", async () => {
    route({ feedback: () => jsonResponse({ error: "This feedback is not valid." }, 400) });
    await openConversation();
    await userEvent.click(screen.getByRole("button", { name: "Suggest a better answer" }));
    const editor = screen.getByRole("group", { name: "Suggest a better answer" });
    const text = within(editor).getByRole("textbox", { name: "Better answer" });
    await userEvent.type(text, " Always pass a radix.");
    await userEvent.click(within(editor).getByRole("button", { name: "Save correction" }));

    expect(await within(editor).findByRole("alert")).toHaveTextContent("This feedback is not valid.");
    expect(text).toHaveValue("Use Number() to parse. Always pass a radix.");
    expect(screen.queryByText("Corrected")).not.toBeInTheDocument();
  });

  it("rates a single tool call", async () => {
    route({ feedback: savedFeedback });
    await openConversation();
    const up = screen.getByRole("button", { name: "Good tool call" });
    await userEvent.click(up);
    expect(up).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")).toHaveLength(1));
    expect(bodiesTo(`/api/conversations/${ID}/feedback`, "PUT")[0]).toEqual({
      messageId: REPLY,
      toolCallId: "call-1",
      rating: "up",
      correction: null,
      note: null,
    });
    // The reply's own rating is separate.
    expect(screen.getByRole("button", { name: "Good response" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows no feedback controls on a reply that is waiting for approval", async () => {
    route({ conversation: awaitingApproval });
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByText("I will edit the file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Good response" })).not.toBeInTheDocument();
  });

  it("changes the training status from the header", async () => {
    route({ training: (body) => jsonResponse(body) });
    await openConversation();
    await userEvent.click(screen.getByRole("button", { name: /Training status: Unreviewed/ }));
    const menu = screen.getByRole("menu", { name: "Training status" });
    expect(within(menu).getByRole("menuitemradio", { name: /Unreviewed/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: /Approved/ }));

    expect(screen.getByRole("button", { name: /Training status: Approved/ })).toBeInTheDocument();
    await waitFor(() =>
      expect(bodiesTo(`/api/conversations/${ID}/training`, "PUT")).toEqual([{ trainingStatus: "approved" }]),
    );
  });

  it("puts the training status back when saving it fails", async () => {
    route({ training: () => jsonResponse({ error: "This conversation no longer exists." }, 404) });
    await openConversation();
    await userEvent.click(screen.getByRole("button", { name: /Training status: Unreviewed/ }));
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Excluded/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This conversation no longer exists.");
    expect(screen.getByRole("button", { name: /Training status: Unreviewed/ })).toBeInTheDocument();
  });

  it("opens an evaluation conversation read-only with a banner", async () => {
    route({ conversation: { ...awaitingApproval, kind: "eval" } });
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByText(/An evaluation run created this conversation/)).toBeInTheDocument();
    expect(screen.getByText("Evaluation", { selector: ".kind-badge" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Message" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Changes/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Training" })).toHaveAttribute("href", "/training?tab=evaluations");
  });

  it("labels a distillation conversation", async () => {
    route({ conversation: { ...finished, kind: "distill" } });
    await openConversation();
    expect(screen.getByText(/A distillation job created this conversation/)).toBeInTheDocument();
    // Review still works on job conversations.
    expect(screen.getByRole("button", { name: "Good response" })).toBeEnabled();
  });
});

describe("AgentApp with the model router", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const enabled = routerConfig({ enabled: true, main: { provider: "ollama", model: "qwen3-big" } });

  const events: AgentEvent[] = [
    { type: "conversation", conversation: { id: ID, title: "Fix the parser", createdAt: NOW, updatedAt: NOW } },
    { type: "message", message: { id: "u1", role: "user", content: "Fix the parser", createdAt: NOW } },
    {
      type: "message",
      message: { id: REPLY, role: "assistant", content: "Partial", reasoning: "", toolCalls: [], model: "qwen3-big", interrupted: false, createdAt: NOW },
    },
    { type: "done", reason: "max_steps" },
  ];

  function route(router: RouterConfig, conversation: ConversationDetail = finished) {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/models?provider=ollama"))
        return jsonResponse({ provider: "ollama", state: "ready", models: ["qwen3", "qwen3-big"] });
      if (url.startsWith("/api/models?provider=gpu")) return jsonResponse({ provider: "gpu", state: "unconfigured", models: [] });
      if (url === "/api/conversations") return jsonResponse({ conversations: [] });
      if (url === "/api/router") return jsonResponse(router);
      if (url === `/api/conversations/${ID}`) return jsonResponse(conversation);
      if ((url === "/api/agent" || url === "/api/agent/approve") && init?.method === "POST") return ndjson(events);
      return jsonResponse({ error: "Not found" }, 404);
    });
  }

  const posted = (url: string) =>
    fetchMock.mock.calls
      .filter(([target, init]) => target === url && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as unknown);

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => fetchMock.mockReset());

  it("offers Auto (router) and sends useRouter with the router's main model on send and continue", async () => {
    route(enabled);
    render(<AgentApp initialConversationId={null} />);
    await userEvent.click(await screen.findByRole("button", { name: /Model: qwen3\. Change model/ }));
    const auto = await screen.findByRole("menuitemradio", { name: /Auto \(router\)/ });
    expect(auto).toHaveAttribute("aria-checked", "false");
    await userEvent.click(auto);
    expect(screen.getByRole("button", { name: "Model: Auto (router). Change model" })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY) ?? "{}")).toMatchObject({ useRouter: true });

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Fix the parser{Enter}");
    await waitFor(() => expect(posted("/api/agent")).toHaveLength(1));
    expect(posted("/api/agent")[0]).toEqual({
      provider: "ollama",
      model: "qwen3-big",
      permissionMode: "ask",
      content: "Fix the parser",
      useRouter: true,
    });

    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(posted("/api/agent")).toHaveLength(2));
    expect(posted("/api/agent")[1]).toEqual({
      conversationId: ID,
      provider: "ollama",
      model: "qwen3-big",
      permissionMode: "ask",
      useRouter: true,
    });
  });

  it("sends useRouter on approvals and shows which model answered", async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ useRouter: true }));
    route(enabled, awaitingApproval);
    render(<AgentApp initialConversationId={ID} />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted("/api/agent/approve")).toHaveLength(1));
    expect(posted("/api/agent/approve")[0]).toEqual({
      conversationId: ID,
      callId: "call-2",
      decision: "approve",
      provider: "ollama",
      model: "qwen3-big",
      permissionMode: "ask",
      useRouter: true,
    });
  });

  it("labels finished replies with their model while Auto is selected", async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ useRouter: true }));
    route(enabled);
    render(<AgentApp initialConversationId={ID} />);
    expect(await screen.findByTitle("Answered by qwen3-big")).toHaveTextContent("Answered by qwen3-big");
  });

  it("falls back to a concrete model when the router is turned off", async () => {
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ useRouter: true }));
    route(routerConfig({ enabled: false, main: { provider: "ollama", model: "qwen3-big" } }));
    render(<AgentApp initialConversationId={null} />);
    await userEvent.click(await screen.findByRole("button", { name: /Model: qwen3\. Change model/ }));
    expect(screen.queryByRole("menuitemradio", { name: /Auto \(router\)/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    await userEvent.type(screen.getByRole("textbox", { name: "Message" }), "Hi{Enter}");
    await waitFor(() => expect(posted("/api/agent")).toHaveLength(1));
    expect(posted("/api/agent")[0]).not.toHaveProperty("useRouter");
  });
});
