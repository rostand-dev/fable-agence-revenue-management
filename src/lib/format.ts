const eur0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const eur2 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clean = (s: string) => s.replace(/[  ]/g, " ");
/** Montant en euros depuis des centimes. Une valeur absente n'est jamais rendue comme zéro. */
export function euro(cents: number | null | undefined, precise = false): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return "inconnu";
  return clean((precise ? eur2 : eur0).format(cents / 100));
}
export function signedEuro(cents: number | null | undefined, precise = false): string {
  if (cents === null || cents === undefined) return "non chiffrable";
  const s = euro(Math.abs(cents), precise);
  return (cents > 0 ? "+" : cents < 0 ? "−" : "") + s;
}
export function pct(x: number | null | undefined, digits = 0): string {
  if (x === null || x === undefined || Number.isNaN(x)) return "inconnu";
  return clean((x * 100).toFixed(digits).replace(".", ",") + " %");
}
export function pts(x: number): string { const v = Math.round(x * 100); return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v) + " pts"; }
