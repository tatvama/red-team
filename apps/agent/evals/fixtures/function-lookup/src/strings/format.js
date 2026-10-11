// Formatting helpers for display text.

export function formatCurrency(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

export function formatPercent(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}
