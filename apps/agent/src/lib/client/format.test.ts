import { describe, expect, it } from "vitest";
import { formatBytes, groupConversations, languageFromPath } from "./format";

describe("groupConversations", () => {
  it("groups by updatedAt into Today, Previous 7 days and Older", () => {
    const now = new Date(2026, 9, 10, 15, 0);
    const at = (date: Date) => ({ id: date.toISOString(), title: "t", createdAt: "", updatedAt: date.toISOString() });
    const groups = groupConversations(
      [at(new Date(2026, 9, 10, 9, 0)), at(new Date(2026, 9, 7, 9, 0)), at(new Date(2026, 8, 1, 9, 0))],
      now,
    );
    expect(groups.map((group) => [group.label, group.conversations.length])).toEqual([
      ["Today", 1],
      ["Previous 7 days", 1],
      ["Older", 1],
    ]);
  });
});

describe("formatBytes and languageFromPath", () => {
  it("formats sizes and maps extensions", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(languageFromPath("src/app/page.tsx")).toBe("tsx");
    expect(languageFromPath("Makefile")).toBe("");
  });
});
