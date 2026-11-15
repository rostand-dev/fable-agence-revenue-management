/**
 * Prix publié estimé : ce que le voyageur devrait voir sur un canal, d'après le prix recommandé par PriceLabs (`price`)
 * et la majoration en pourcentage que le propriétaire a saisie pour ce canal.
 * C'est une estimation d'affichage : NuitSignal ne modifie jamais les prix de PriceLabs.
 * Fonctions pures, sans accès base ni réseau.
 */

/** Majoration d'un canal. `pct === null` : non renseignée, donc inconnue (jamais traitée comme 0 %). */
export type ChannelMarkup = { key: string; label: string; pct: number | null };

/** Plafond de saisie : au-delà, il s'agit presque sûrement d'une faute de frappe. */
export const MAX_MARKUP_PCT = 100;

export type PublishableDay = { state: "FREE" | "BOOKED" | "BLOCKED"; recommendedPriceCents: number | null | undefined };
export type PublishedEstimate = {
  /** Valeur exacte, en centimes décimaux, conservée sans arrondi d'affichage. */
  exactCents: number;
  /** Valeur arrondie à l'euro, en euros entiers, pour l'affichage. */
  displayEuros: number;
};

/**
 * Lit une majoration saisie : « 15 », « 15,5 », « 15.25 », « 18 % ». Vide → inconnue (null).
 * Refuse le négatif, plus de deux décimales, tout ce qui n'est pas un nombre, et plus de 100 %.
 */
export function parseMarkupPct(input: string | null | undefined): { ok: true; pct: number | null } | { ok: false; error: string } {
  const raw = String(input ?? "").trim().replace(/\s+/g, "").replace(/%$/, "");
  if (raw === "") return { ok: true, pct: null };
  if (raw.startsWith("-")) return { ok: false, error: "Une majoration ne peut pas être négative." };
  if (!/^\d+([.,]\d+)?$/.test(raw)) return { ok: false, error: "Saisissez un pourcentage, par exemple 15 ou 15,5." };
  if (/[.,]\d{3,}$/.test(raw)) return { ok: false, error: "Deux décimales au maximum." };
  const pct = Number(raw.replace(",", "."));
  if (pct > MAX_MARKUP_PCT) return { ok: false, error: `Une majoration ne dépasse pas ${MAX_MARKUP_PCT} %.` };
  return { ok: true, pct };
}

/**
 * Une nuit est estimable si elle est libre (ni réservée ni bloquée) et si PriceLabs fournit un prix recommandé strictement positif.
 * `user_price` (prix envoyé à SuperHote) n'intervient pas dans le calcul : il est conservé pour la comparaison avec SuperHote.
 */
export function isEstimable(day: PublishableDay): boolean {
  return day.state === "FREE" && typeof day.recommendedPriceCents === "number" && Number.isFinite(day.recommendedPriceCents) && day.recommendedPriceCents > 0;
}

/**
 * prix_publié_estimé = price × (1 + majoration / 100).
 * Renvoie null si la nuit n'est pas estimable ou si la majoration est inconnue ou invalide.
 */
export function estimatePublishedPrice(day: PublishableDay, markupPct: number | null | undefined): PublishedEstimate | null {
  if (!isEstimable(day)) return null;
  if (markupPct === null || markupPct === undefined || !Number.isFinite(markupPct) || markupPct < 0) return null;
  const exactCents = Math.round(day.recommendedPriceCents! * (1 + markupPct / 100) * 1e6) / 1e6; // neutralise le bruit des flottants
  return { exactCents, displayEuros: Math.round(exactCents / 100) };
}

/** Estimation pour chaque canal : `null` quand la majoration est inconnue ou la nuit non estimable. */
export function estimateAllChannels(day: PublishableDay, markups: ChannelMarkup[]): { key: string; label: string; pct: number | null; estimate: PublishedEstimate | null }[] {
  return markups.map((m) => ({ key: m.key, label: m.label, pct: m.pct, estimate: estimatePublishedPrice(day, m.pct) }));
}

/** Canal affiché par défaut : celui demandé s'il est renseigné, sinon Airbnb s'il est renseigné, sinon le premier renseigné. */
export function pickDefaultChannel(markups: ChannelMarkup[], wantedKey?: string | null): ChannelMarkup | null {
  const known = markups.filter((m) => m.pct !== null);
  return known.find((m) => m.key === wantedKey) ?? known.find((m) => m.key.includes("airbnb")) ?? known[0] ?? null;
}

/** Identifiant stable d'un canal à partir de son nom (sans accents ni casse). */
export const markupKey = (label: string) => label.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Écart prix envoyé − prix recommandé, en centimes. null si l'un des deux est inconnu. */
export function sentMinusRecommended(sentCents: number | null | undefined, recommendedCents: number | null | undefined): number | null {
  if (typeof sentCents !== "number" || typeof recommendedCents !== "number") return null;
  return sentCents - recommendedCents;
}

/**
 * Lit la liste de majorations saisie dans le formulaire (deux listes parallèles : noms et pourcentages).
 * Une ligne entièrement vide est ignorée ; un nom sans pourcentage est conservé avec une majoration inconnue.
 * Refuse un pourcentage sans nom, un nom en double et toute valeur invalide.
 */
export function parseMarkupList(labels: string[], pcts: string[]): { ok: true; markups: ChannelMarkup[] } | { ok: false; error: string } {
  const out: ChannelMarkup[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < labels.length; i++) {
    const label = String(labels[i] ?? "").trim().slice(0, 40);
    const rawPct = String(pcts[i] ?? "").trim();
    if (!label && !rawPct) continue;
    if (!label) return { ok: false, error: "Un pourcentage de majoration n'a pas de nom de canal." };
    const key = markupKey(label);
    if (!key) return { ok: false, error: `Le nom de canal « ${label} » n'est pas valide.` };
    if (seen.has(key)) return { ok: false, error: `Le canal « ${label} » apparaît deux fois.` };
    const p = parseMarkupPct(rawPct);
    if (!p.ok) return { ok: false, error: `Majoration « ${label} » : ${p.error}` };
    seen.add(key);
    out.push({ key, label, pct: p.pct });
  }
  return { ok: true, markups: out };
}
