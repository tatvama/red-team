// Returns the sum of the first `count` numbers in `values`.
// Example: sumFirst([1, 2, 3, 4], 2) === 3
export function sumFirst(values, count) {
  let total = 0;
  for (let i = 0; i <= count; i++) {
    total += values[i];
  }
  return total;
}
