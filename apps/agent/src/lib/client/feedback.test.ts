import { describe, expect, it } from "vitest";
import { feedbackView, readyConnection, routerConfig } from "@/test/fixtures";
import { agentReducer, createInitialState, resolveChoice } from "./agent-state";
import { feedbackByMessage, findFeedback, isEmptyFeedback, optimisticFeedback, ratingRequest, replaceFeedback } from "./feedback";

const REPLY = "55555555-5555-4555-8555-555555555555";
const CONVERSATION = "11111111-1111-4111-8111-111111111111";

describe("feedback helpers", () => {
  const reply = feedbackView({ rating: "up" });
  const tool = feedbackView({ toolCallId: "call-1", rating: "down" });

  it("finds and replaces entries by reply and tool call", () => {
    expect(findFeedback([reply, tool], REPLY, null)).toBe(reply);
    expect(findFeedback([reply, tool], REPLY, "call-1")).toBe(tool);
    expect(findFeedback([reply], REPLY, "call-2")).toBeNull();

    const corrected = { ...reply, correction: "Better" };
    expect(replaceFeedback([reply, tool], REPLY, null, corrected)).toEqual([tool, corrected]);
    expect(replaceFeedback([reply, tool], REPLY, "call-1", null)).toEqual([reply]);
    expect(feedbackByMessage([reply, tool, feedbackView({ messageId: "other" })]).get(REPLY)).toEqual([reply, tool]);
  });

  it("toggles a rating while keeping the correction and note", () => {
    const current = feedbackView({ rating: "up", correction: "Better", note: "Why" });
    expect(ratingRequest(current, { messageId: REPLY, toolCallId: null }, "up")).toEqual({
      messageId: REPLY,
      toolCallId: null,
      rating: null,
      correction: "Better",
      note: "Why",
    });
    expect(ratingRequest(null, { messageId: REPLY, toolCallId: "call-1" }, "down")).toMatchObject({
      toolCallId: "call-1",
      rating: "down",
      correction: null,
    });
  });

  it("treats an all-null request as clearing the feedback", () => {
    const request = { messageId: REPLY, toolCallId: null, rating: null, correction: null, note: null };
    expect(isEmptyFeedback(request)).toBe(true);
    expect(optimisticFeedback(request)).toBeNull();
    expect(optimisticFeedback({ ...request, rating: "up" }, new Date("2026-10-10T12:00:00.000Z"))).toEqual({
      ...request,
      rating: "up",
      updatedAt: "2026-10-10T12:00:00.000Z",
    });
  });
});

describe("agentReducer feedback and training status", () => {
  const loaded = { ...createInitialState(CONVERSATION), phase: "idle" as const, trainingStatus: "unreviewed" as const };

  it("reverts a failed save only while the optimistic entry is still current", () => {
    const optimistic = feedbackView({ rating: "up" });
    const shown = agentReducer(loaded, {
      type: "feedback_entry",
      conversationId: CONVERSATION,
      messageId: REPLY,
      toolCallId: null,
      entry: optimistic,
    });
    expect(shown.feedback).toEqual([optimistic]);

    const newer = feedbackView({ rating: "down" });
    const changedAgain = agentReducer(shown, {
      type: "feedback_entry",
      conversationId: CONVERSATION,
      messageId: REPLY,
      toolCallId: null,
      entry: newer,
    });
    const revert = {
      type: "feedback_entry" as const,
      conversationId: CONVERSATION,
      messageId: REPLY,
      toolCallId: null,
      entry: null,
      ifCurrent: optimistic,
    };
    // A newer click won; reverting the older one must not undo it.
    expect(agentReducer(changedAgain, revert)).toBe(changedAgain);
    expect(agentReducer(shown, revert).feedback).toEqual([]);
    // Feedback for another conversation is ignored.
    expect(agentReducer(shown, { ...revert, conversationId: "other", ifCurrent: undefined })).toBe(shown);
  });

  it("sets the training status and reverts it conditionally", () => {
    const approved = agentReducer(loaded, { type: "training_status", conversationId: CONVERSATION, trainingStatus: "approved" });
    expect(approved.trainingStatus).toBe("approved");
    const excluded = agentReducer(approved, { type: "training_status", conversationId: CONVERSATION, trainingStatus: "excluded" });
    expect(
      agentReducer(excluded, { type: "training_status", conversationId: CONVERSATION, trainingStatus: "unreviewed", ifCurrent: "approved" }),
    ).toBe(excluded);
    expect(agentReducer(approved, { type: "new_task" })).toMatchObject({ trainingStatus: null, feedback: [], kind: "chat" });
  });
});

describe("resolveChoice", () => {
  const connections = { ollama: readyConnection("ollama", ["qwen3"]), gpu: null };
  const router = routerConfig({ enabled: true, main: { provider: "gpu", model: "big" } });

  it("uses the router's main model for Auto while the router is enabled", () => {
    expect(resolveChoice({ provider: null, model: null, useRouter: true }, connections, router)).toEqual({
      provider: "gpu",
      model: "big",
      auto: true,
    });
  });

  it("falls back to a concrete model when Auto is off or the router cannot serve it", () => {
    const concrete = { provider: "ollama", model: "qwen3", auto: false };
    expect(resolveChoice({ provider: null, model: null, useRouter: false }, connections, router)).toEqual(concrete);
    expect(resolveChoice({ provider: null, model: null, useRouter: true }, connections, { ...router, enabled: false })).toEqual(
      concrete,
    );
    expect(resolveChoice({ provider: null, model: null, useRouter: true }, connections, null)).toEqual(concrete);
  });
});
