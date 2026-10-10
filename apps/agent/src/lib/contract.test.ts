import { describe, expect, it } from "vitest";
import { agentRequestSchema, approvalRequestSchema, effectivePolicy } from "./contract";

describe("effectivePolicy", () => {
  it.each([
    // mode, risk, tool policy, always allowed, expected
    ["ask", "read", "auto", false, "auto"],
    ["ask", "write", "ask", false, "ask"],
    ["ask", "execute", "ask", true, "auto"],
    ["accept_edits", "write", "ask", false, "auto"],
    ["accept_edits", "execute", "ask", false, "ask"],
    ["accept_edits", "network", "ask", false, "ask"],
    ["plan", "write", "auto", false, "off"],
    ["plan", "execute", "ask", true, "off"],
    ["plan", "network", "auto", false, "auto"],
    ["plan", "read", "auto", false, "auto"],
    ["full_auto", "execute", "ask", false, "auto"],
    ["full_auto", "execute", "off", false, "off"],
  ] as const)("%s mode, %s risk, %s policy, allowed=%s → %s", (mode, risk, policy, allowed, expected) => {
    expect(effectivePolicy(mode, risk, policy, allowed)).toBe(expected);
  });
});

describe("request schemas", () => {
  const base = { provider: "ollama", model: "qwen", permissionMode: "ask" };

  it("accepts a new message or a resume of an existing conversation", () => {
    expect(agentRequestSchema.safeParse({ ...base, content: "hi" }).success).toBe(true);
    expect(agentRequestSchema.safeParse({ ...base, conversationId: crypto.randomUUID() }).success).toBe(true);
  });

  it("rejects requests with neither, unknown fields, or upstream URLs", () => {
    expect(agentRequestSchema.safeParse(base).success).toBe(false);
    expect(agentRequestSchema.safeParse({ ...base, content: "hi", baseUrl: "http://evil" }).success).toBe(false);
    expect(agentRequestSchema.safeParse({ ...base, content: "hi", provider: "openai" }).success).toBe(false);
  });

  it("only accepts known approval decisions", () => {
    const approval = { ...base, conversationId: crypto.randomUUID(), callId: "call_1" };
    expect(approvalRequestSchema.safeParse({ ...approval, decision: "approve_always" }).success).toBe(true);
    expect(approvalRequestSchema.safeParse({ ...approval, decision: "sudo" }).success).toBe(false);
  });
});
