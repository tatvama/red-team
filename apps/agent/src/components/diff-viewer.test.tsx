import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { diffFile } from "@/test/fixtures";
import { DiffFileView, splitRows } from "./diff-viewer";

/** Each table row as its cell texts. */
function rows(table: HTMLElement): string[][] {
  return Array.from(table.querySelectorAll("tr.diff-row"), (row) =>
    Array.from(row.querySelectorAll("td"), (cell) => cell.textContent ?? ""),
  );
}

describe("DiffFileView", () => {
  it("renders a unified diff with old and new line numbers", () => {
    render(<DiffFileView file={diffFile()} view="unified" />);
    const table = screen.getByRole("table", { name: /Changes in src\/parser\.ts, unified view/ });
    expect(within(table).getByText("@@ -10,3 +10,4 @@ function parse()")).toBeInTheDocument();
    expect(rows(table)).toEqual([
      ["10", "10", " ", "const a = 1;"],
      ["11", "", "-", "const b = 2;"],
      ["", "11", "+", "const b = 3;"],
      ["", "12", "+", "const c = 4;"],
      ["12", "13", " ", "return a;"],
    ]);
    expect(table.querySelectorAll("tr.diff-row--add")).toHaveLength(2);
    expect(table.querySelectorAll("tr.diff-row--del")).toHaveLength(1);
  });

  it("renders a split diff with deletions beside the additions that replace them", () => {
    render(<DiffFileView file={diffFile()} view="split" />);
    const table = screen.getByRole("table", { name: /side by side/ });
    expect(rows(table)).toEqual([
      ["10", " const a = 1;", "10", " const a = 1;"],
      ["11", "-const b = 2;", "11", "+const b = 3;"],
      ["", "", "12", "+const c = 4;"],
      ["12", " return a;", "13", " return a;"],
    ]);
    expect(table.querySelectorAll("td.diff-cell--del.diff-code")).toHaveLength(1);
    expect(table.querySelectorAll("td.diff-cell--add.diff-code")).toHaveLength(2);
    expect(table.querySelectorAll("td.diff-cell--empty")).toHaveLength(2);
  });

  it("shows the path, status and counts in a collapsible header", async () => {
    render(<DiffFileView file={diffFile({ status: "added" })} view="unified" />);
    const toggle = screen.getByRole("button", { name: "Added: src/parser.ts, 2 added, 1 removed" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("+2 added");
    expect(toggle).toHaveTextContent("−1 removed");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("marks binary files instead of showing hunks", () => {
    render(<DiffFileView file={diffFile({ path: "logo.png", binary: true, hunks: [] })} view="unified" />);
    expect(screen.getByText("Binary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /logo\.png, 2 added, 1 removed, binary$/ })).toBeInTheDocument();
    expect(screen.getByText(/Binary file\. Its contents are not shown\./)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("marks truncated files", () => {
    render(<DiffFileView file={diffFile({ truncated: true })} view="split" />);
    expect(screen.getByText("Truncated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /, truncated$/ })).toBeInTheDocument();
    expect(screen.getByText(/This diff was shortened/)).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("shows both paths for a rename", () => {
    render(<DiffFileView file={diffFile({ status: "renamed", oldPath: "src/old.ts", path: "src/new.ts" })} view="unified" />);
    expect(screen.getByRole("button", { name: "Renamed: src/old.ts renamed to src/new.ts, 2 added, 1 removed" })).toBeInTheDocument();
  });
});

describe("splitRows", () => {
  it("pairs a run of deletions with the additions that follow it", () => {
    const result = splitRows([
      { type: "del", text: "a", oldLine: 1, newLine: null },
      { type: "del", text: "b", oldLine: 2, newLine: null },
      { type: "add", text: "c", oldLine: null, newLine: 1 },
    ]);
    expect(result).toEqual([
      { left: { number: 1, text: "a", type: "del" }, right: { number: 1, text: "c", type: "add" } },
      { left: { number: 2, text: "b", type: "del" }, right: null },
    ]);
  });
});
