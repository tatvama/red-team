// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { evalTools } from "./runner";

// Evaluation tasks run unattended in full_auto, so only tools that stay inside the task folder
// are offered by default.

const names = () => evalTools().map((tool) => tool.name);

describe("evalTools", () => {
  it("keeps file, plan, git and sub-agent tools", () => {
    expect(names()).toEqual(
      expect.arrayContaining(["list_files", "read_file", "search_files", "edit_file", "write_file", "update_plan", "git_diff"]),
    );
  });

  it("never offers network or memory tools", () => {
    for (const name of ["web_search", "web_fetch", "save_memory", "forget_memory"]) expect(names()).not.toContain(name);
  });

  it("offers shell commands only when they run in the Docker sandbox", () => {
    vi.stubEnv("COMMAND_RUNNER", "off");
    expect(names()).not.toContain("run_command");
    vi.stubEnv("COMMAND_RUNNER", "host");
    expect(names()).not.toContain("run_command");
    vi.stubEnv("COMMAND_RUNNER", "docker");
    expect(names()).toContain("run_command");
  });
});
