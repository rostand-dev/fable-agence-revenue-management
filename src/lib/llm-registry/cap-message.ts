import type { CapState } from "./cap-state";

export const fmtEur = (v: number): string => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(v);

/** Texte de l'alerte de plafond : null en dessous de 80 % et sans plafond ; « alerte » de 80 % à 100 % ; « atteint » à 100 % et au-delà. Pur. */
export function capAlert(cap: CapState): { level: "alert" | "reached"; title: string; body: string } | null {
  if (cap.level !== "alert" && cap.level !== "reached") return null;
  const pct = Math.floor((cap.ratio ?? 0) * 100);
  const spent = `${fmtEur(cap.spentEur)} dépensés sur ${fmtEur(cap.capEur ?? 0)} ce mois-ci (UTC).`;
  return cap.level === "reached"
    ? { level: "reached", title: "Plafond mensuel de dépense atteint", body: `${spent} Les agents travaillent en mode déterministe jusqu'au 1er du mois prochain, ou jusqu'à un relèvement du plafond.` }
    : { level: "alert", title: `Plafond mensuel presque atteint (${pct} %)`, body: `${spent} À 100 %, les agents passeront en mode déterministe jusqu'au 1er du mois prochain.` };
}
