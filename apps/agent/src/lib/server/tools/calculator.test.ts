// @vitest-environment node
import { describe, expect, it } from "vitest";
import { calculatorTool, evaluate, formatNumber } from "./calculator";

const ctx = { signal: new AbortController().signal, conversationId: "test" };
const calc = (expression: string) => calculatorTool.run({ expression }, ctx);

describe("evaluate", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 / 4", 2.5],
    ["10 % 4", 2],
    ["2 ^ 10", 1024],
    ["2 ** 3", 8],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["(-2) ^ 2", 4],
    ["2 ^ -1", 0.5],
    ["--3", 3],
    ["+4 - -1", 5],
    ["1.5e3 + .5", 1500.5],
    ["2E-2", 0.02],
    ["sqrt(16) + abs(-3)", 7],
    ["round(2.5) + floor(2.7) + ceil(2.1)", 8],
    ["ln(e)", 1],
    ["log(1000)", 3],
    ["log(8, 2)", 3],
    ["log10(100) + log2(8)", 5],
    ["sin(0) + cos(0)", 1],
    ["tan(0) + asin(0) + acos(1) + atan(0)", 0],
    ["exp(0)", 1],
    ["min(3, 1, 2) + max(3, 1, 2)", 4],
    ["pow(2, 8)", 256],
    ["PI", Math.PI],
    ["2 * pi", 2 * Math.PI],
  ])("%s", (expression, expected) => {
    expect(evaluate(expression)).toBeCloseTo(expected, 10);
  });

  it("formats to 12 significant digits", () => {
    expect(formatNumber(0.1 + 0.2)).toBe("0.3");
    expect(formatNumber(1 / 3)).toBe("0.333333333333");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(123456789012345)).toBe("123456789012000");
  });
});

describe("calculator tool", () => {
  it("returns expression = result", async () => {
    expect(await calc(" (3 + 4) * 2 ")).toEqual({ status: "ok", content: "(3 + 4) * 2 = 14" });
    expect(await calc("sqrt(2)")).toEqual({ status: "ok", content: "sqrt(2) = 1.41421356237" });
  });

  it.each([
    ["1 / 0", "Division by zero"],
    ["5 % 0", "Modulo by zero"],
    ["(1 + 2", "Mismatched parentheses"],
    ["1 + 2)", "Mismatched parentheses"],
    ["max(1, 2", "Mismatched parentheses"],
    ["1 +", "Unexpected end of expression"],
    ["", "Expression is empty"],
    ["2 3", "Unexpected '3'"],
    ["foo(1)", "Unknown identifier: foo"],
    ["constructor", "Unknown identifier: constructor"],
    ["__proto__", "Unknown identifier: __proto__"],
    ["process", "Unknown identifier: process"],
    ["toString(1)", "Unknown identifier: tostring"],
    ["globalThis", "Unknown identifier: globalthis"],
    ["sqrt", "sqrt must be called with parentheses"],
    ["pow(2)", "pow expects 2 arguments, got 1"],
    ["sqrt(1, 2)", "sqrt expects 1 argument, got 2"],
    ["sqrt(-1)", "Result is not a finite number"],
    ["10 ^ 400", "Result is not a finite number"],
    ["2; 3", "Unexpected character ';'"],
    ["alert`1`", "Unexpected character '`'"],
    ["a.b", "Unexpected character '.'"],
  ])("rejects %j", async (expression, message) => {
    const result = await calc(expression);
    expect(result.status).toBe("error");
    expect(result.content).toContain(message);
  });
});
