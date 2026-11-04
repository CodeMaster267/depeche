/** Short, friendly cost: "0.8¢", "3¢", "$1.20". */
export function costText(usd: number): string {
  if (usd < 0.001) return "less than 0.1¢";
  if (usd < 0.1) return `${(usd * 100).toFixed(usd < 0.01 ? 2 : 1).replace(/\.?0+$/, "")}¢`;
  return `$${usd.toFixed(2)}`;
}
