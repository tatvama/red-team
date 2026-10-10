// A scripted OpenAI-compatible model server for development and end-to-end tests.
// It lets you exercise streaming, reasoning, tool calls and approvals without a GPU or Ollama.
//
//   node scripts/mock-llm.mjs            (listens on 127.0.0.1:11435)
//   OLLAMA_BASE_URL=http://127.0.0.1:11435/v1 pnpm dev
//
// Prompts containing "delegate", "plan", "list", "write" or "run" trigger the matching tool call.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 11435);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(delta, finish = null) {
  return `data: ${JSON.stringify({
    id: "mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "mock-agent",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function pieces(text) {
  return text.match(/.{1,12}/gs) ?? [];
}

function decide(messages, toolNames) {
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const preview = String(last.content).replace(/\s+/g, " ").slice(0, 160);
    return { reasoning: "The tool finished. I will summarize the result.", text: `Done. The tool reported: \`${preview}\`` };
  }
  const prompt = String(last?.content ?? "").toLowerCase();
  const tool = (name, args) => (toolNames.has(name) ? { name, args } : null);
  const call =
    (prompt.includes("delegate") &&
      tool("delegate_tasks", {
        tasks: [
          { role: "researcher", task: "List the files in the workspace and summarize them." },
          { role: "reviewer", task: "Review the current changes for problems." },
        ],
      })) ||
    (prompt.includes("plan") &&
      tool("update_plan", {
        plan: [
          { step: "Explore the workspace", status: "completed" },
          { step: "Make the change", status: "in_progress" },
          { step: "Verify the result", status: "pending" },
        ],
      })) ||
    (prompt.includes("list") && tool("list_files", { path: "." })) ||
    (prompt.includes("write") && tool("write_file", { path: "hello.txt", content: "Hello from Tatvam\n" })) ||
    (prompt.includes("run") && tool("run_command", { command: "echo hello" })) ||
    null;
  if (call) return { reasoning: `The user wants me to use ${call.name}. I will call it.`, call };
  return {
    reasoning: "This is a simple question. I can answer directly.",
    text: `**Mock reply.** You said: _${String(last?.content ?? "").slice(0, 200)}_\n\n\`\`\`ts\nconst ready = true;\n\`\`\``,
  };
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ object: "list", data: [{ id: "mock-agent", object: "model" }] }));
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ error: { message: "Not found" } }));
  }
  let body = "";
  for await (const part of request) body += part;
  const payload = JSON.parse(body);
  const toolNames = new Set((payload.tools ?? []).map((tool) => tool.function.name));
  const plan = decide(payload.messages ?? [], toolNames);

  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  for (const text of pieces(plan.reasoning)) {
    response.write(chunk({ reasoning_content: text }));
    await sleep(15);
  }
  if (plan.call) {
    const id = `call_${Math.random().toString(36).slice(2, 10)}`;
    const args = JSON.stringify(plan.call.args);
    response.write(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: plan.call.name, arguments: "" } }] }));
    for (const text of pieces(args)) {
      response.write(chunk({ tool_calls: [{ index: 0, function: { arguments: text } }] }));
      await sleep(10);
    }
    response.write(chunk({}, "tool_calls"));
  } else {
    for (const text of pieces(plan.text)) {
      response.write(chunk({ content: text }));
      await sleep(20);
    }
    response.write(chunk({}, "stop"));
  }
  response.end("data: [DONE]\n\n");
});

server.listen(port, "127.0.0.1", () => console.log(`Mock model server on http://127.0.0.1:${port}/v1`));
