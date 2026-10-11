import assert from "node:assert/strict";
import { test } from "node:test";
import { sumFirst } from "./sum.js";

test("sums the first two numbers", () => {
  assert.equal(sumFirst([1, 2, 3, 4], 2), 3);
});
