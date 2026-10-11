import { median } from "./math/stats.js";
import { formatCurrency } from "./strings/format.js";

export function priceSummary(prices) {
  return `Median price: ${formatCurrency(median(prices))}`;
}
