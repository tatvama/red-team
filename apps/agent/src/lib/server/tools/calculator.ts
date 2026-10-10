import { z } from "zod";
import type { ToolDefinition } from "./types";

// A hand-written recursive-descent evaluator. Nothing here reaches eval, Function or object
// property lookup on user text: identifiers resolve only through the two Maps below.

class CalcError extends Error {}

type Token = { kind: "number"; value: number } | { kind: "ident"; value: string } | { kind: "op"; value: string };

const CONSTANTS = new Map<string, number>([
  ["pi", Math.PI],
  ["e", Math.E],
]);

type Fn = { min: number; max: number; apply: (...args: number[]) => number };
const one = (apply: (x: number) => number): Fn => ({ min: 1, max: 1, apply });

const FUNCTIONS = new Map<string, Fn>([
  ["sqrt", one(Math.sqrt)],
  ["abs", one(Math.abs)],
  ["round", one(Math.round)],
  ["floor", one(Math.floor)],
  ["ceil", one(Math.ceil)],
  ["ln", one(Math.log)],
  ["log", { min: 1, max: 2, apply: (x: number, base?: number) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) }],
  ["log10", one(Math.log10)],
  ["log2", one(Math.log2)],
  ["sin", one(Math.sin)],
  ["cos", one(Math.cos)],
  ["tan", one(Math.tan)],
  ["asin", one(Math.asin)],
  ["acos", one(Math.acos)],
  ["atan", one(Math.atan)],
  ["exp", one(Math.exp)],
  ["min", { min: 1, max: Infinity, apply: Math.min }],
  ["max", { min: 1, max: Infinity, apply: Math.max }],
  ["pow", { min: 2, max: 2, apply: Math.pow }],
]);

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*/;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const rest = input.slice(i);
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (NUMBER.test(rest)) {
      const text = NUMBER.exec(rest)![0];
      tokens.push({ kind: "number", value: Number(text) });
      i += text.length;
    } else if (IDENT.test(rest)) {
      const text = IDENT.exec(rest)![0];
      tokens.push({ kind: "ident", value: text.toLowerCase() });
      i += text.length;
    } else if (rest.startsWith("**")) {
      tokens.push({ kind: "op", value: "^" });
      i += 2;
    } else if ("+-*/%^(),".includes(ch)) {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else {
      throw new CalcError(`Unexpected character '${ch}' at position ${i + 1}`);
    }
  }
  return tokens;
}

/**
 * Grammar (lowest to highest precedence):
 *   expr    := term (("+" | "-") term)*
 *   term    := unary (("*" | "/" | "%") unary)*
 *   unary   := ("+" | "-") unary | power
 *   power   := primary ("^" unary)?          right-associative; -2^2 = -4
 *   primary := number | constant | function "(" expr ("," expr)* ")" | "(" expr ")"
 */
class Parser {
  private index = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    if (this.tokens.length === 0) throw new CalcError("Expression is empty");
    const value = this.expr();
    const extra = this.peek();
    if (extra) throw new CalcError(extra.value === ")" ? "Mismatched parentheses" : `Unexpected '${extra.value}'`);
    return value;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private isOp(value: string): boolean {
    const token = this.peek();
    return token?.kind === "op" && token.value === value;
  }

  private expect(value: string): void {
    if (!this.isOp(value)) throw new CalcError(value === ")" ? "Mismatched parentheses" : `Expected '${value}'`);
    this.index++;
  }

  private expr(): number {
    let value = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.tokens[this.index++].value;
      const right = this.term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  private term(): number {
    let value = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.tokens[this.index++].value;
      const right = this.unary();
      if (op === "*") {
        value *= right;
      } else {
        if (right === 0) throw new CalcError(op === "/" ? "Division by zero" : "Modulo by zero");
        value = op === "/" ? value / right : value % right;
      }
    }
    return value;
  }

  private unary(): number {
    if (this.isOp("-")) {
      this.index++;
      return -this.unary();
    }
    if (this.isOp("+")) {
      this.index++;
      return this.unary();
    }
    return this.power();
  }

  private power(): number {
    const base = this.primary();
    if (!this.isOp("^")) return base;
    this.index++;
    return base ** this.unary();
  }

  private primary(): number {
    const token = this.peek();
    if (!token) throw new CalcError("Unexpected end of expression");
    this.index++;
    if (token.kind === "number") return token.value;
    if (token.kind === "op") {
      if (token.value !== "(") throw new CalcError(`Unexpected '${token.value}'`);
      const value = this.expr();
      this.expect(")");
      return value;
    }
    const fn = FUNCTIONS.get(token.value);
    if (fn) return this.call(token.value, fn);
    const constant = CONSTANTS.get(token.value);
    if (constant !== undefined) return constant;
    throw new CalcError(`Unknown identifier: ${token.value}`);
  }

  private call(name: string, fn: Fn): number {
    if (!this.isOp("(")) throw new CalcError(`${name} must be called with parentheses, for example ${name}(2)`);
    this.index++;
    const args = [this.expr()];
    while (this.isOp(",")) {
      this.index++;
      args.push(this.expr());
    }
    this.expect(")");
    if (args.length < fn.min || args.length > fn.max) {
      const expected = fn.max === Infinity ? `at least ${fn.min}` : fn.min === fn.max ? `${fn.min}` : `${fn.min} or ${fn.max}`;
      throw new CalcError(`${name} expects ${expected} argument${expected === "1" ? "" : "s"}, got ${args.length}`);
    }
    return fn.apply(...args);
  }
}

/** Evaluates an arithmetic expression. Throws CalcError for invalid input or a non-finite result. */
export function evaluate(expression: string): number {
  const result = new Parser(tokenize(expression)).parse();
  if (!Number.isFinite(result)) throw new CalcError("Result is not a finite number");
  return result;
}

export function formatNumber(value: number): string {
  const rounded = Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

const schema = z
  .object({
    expression: z
      .string()
      .min(1)
      .max(500)
      .describe('Arithmetic expression, for example "(3 + 4) * 2^10 / sqrt(2)" or "log(1000) + ln(e)".'),
  })
  .strict();

export const calculatorTool: ToolDefinition<typeof schema> = {
  name: "calculator",
  title: "Calculator",
  description:
    "Evaluate an arithmetic expression exactly instead of doing mental math. Supports + - * / % ^ (power), " +
    "parentheses, unary minus, scientific notation, constants pi and e, and functions sqrt abs round floor ceil " +
    "ln log (base 10, or log(x, base)) log10 log2 sin cos tan asin acos atan (radians) exp min max pow. " +
    "Results have up to 12 significant digits.",
  schema,
  defaultPolicy: "auto",
  risk: "read",
  available: () => ({ ok: true }),
  summarize: (input) => `Calculate ${input.expression.length > 80 ? `${input.expression.slice(0, 80)}...` : input.expression}`,
  async run(input) {
    const expression = input.expression.trim();
    try {
      return { status: "ok", content: `${expression} = ${formatNumber(evaluate(expression))}` };
    } catch (error) {
      if (error instanceof CalcError) return { status: "error", content: error.message };
      throw error;
    }
  },
};
