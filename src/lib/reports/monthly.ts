/**
 * Rapport mensuel certifié (US-112, blueprint §6.5). Module pur, sans accès base.
 *
 * Un rapport repose sur un **instantané** : les métriques du mois, figées au moment de la génération. Le texte est assemblé par règles à partir de cet instantané
 * (aucun modèle de langage), puis peut être retouché par une personne habilitée. **Aucun nombre du texte ne peut être absent de l'instantané** : sans cela,
 * la certification est refusée. Une valeur inconnue reste « inconnue », jamais un zéro ; la contribution et l'objectif, non suivis, sont dits inconnus.
 */
import { fmtMonth, type ISODate } from "../dates";
import type { MonthKpi } from "../engine/metrics";
import { CHANNEL_LABEL } from "../engine/types";
import { OUTCOME_LABEL, OUTCOMES, type Outcome } from "../experiments/outcome";
import { euro, pct } from "../format";

export type Trend = "croissante" | "stable" | "décroissante" | "inconnue";
export const TREND_LABEL: Record<Trend, string> = { croissante: "croissante", stable: "stable", décroissante: "décroissante", inconnue: "inconnue" };

/** Même règle de tendance que le bilan mensuel : ±3 % ; sans référence (mois précédent nul), « inconnue ». */
export function trendOf(cur: number | null, prev: number | null): Trend {
  if (cur === null || prev === null || prev === 0) return "inconnue";
  return cur > prev * 1.03 ? "croissante" : cur < prev * 0.97 ? "décroissante" : "stable";
}

export type ReportKpis = {
  nights: number; available: number; blockedNights: number; occupancy: number | null; grossCents: number;
  /** Net des nuits à commission connue ; null si aucune commission connue (jamais 0 par défaut). */
  netCents: number | null;
  netAdrCents: number | null;
  /** null dès que le net est partiel : un net par nuit disponible sous-évalué n'est pas certifié. */
  netRevpanCents: number | null;
  netStatus: string; netIncomplete: boolean;
};
export type ReportAction = { code: string; label: string; outcome: Outcome; summary: string; interpretation: string; reasons: string[]; legacy: boolean };
export type ReportSnapshot = {
  version: 1; month: string; generatedAt: string;
  property: { id: string; name: string; isDemo: boolean };
  kpis: ReportKpis;
  previous: { month: string; kpis: ReportKpis } | null;
  trends: { net: Trend; occupancy: Trend; netAdr: Trend; netRevpan: Trend };
  channels: { channel: string; label: string; netCents: number; share: number | null }[];
  market: { occupancy: number | null; gapPts: number | null; days: number };
  actions: ReportAction[];
  outcomes: Record<Outcome, number>;
  decisions: { total: number; noAction: number; rejected: number; approved: number };
  open: { code: string; title: string; option: string | null; veto: boolean }[];
  unknowns: { contribution: string; objective: string };
};

export const UNKNOWN_CONTRIBUTION = "Contribution non calculée : les coûts variables réels par séjour ne sont pas suivis.";
export const UNKNOWN_OBJECTIVE = "Écart à l'objectif inconnu : aucun objectif chiffré n'est renseigné pour ce logement.";

/** Sans nuit vendue, rien n'est mesuré : revenu, occupation et prix sont inconnus (jamais 0), le mois pouvant précéder l'historique du logement. */
const toKpis = (k: MonthKpi): ReportKpis => {
  const none = k.nights === 0;
  return {
    nights: k.nights, available: k.available, blockedNights: k.blockedNights, occupancy: none || k.available <= 0 ? null : k.occupancy, grossCents: k.grossCents,
    netCents: none || k.netStatus === "UNKNOWN" ? null : k.netCents, netAdrCents: none ? null : k.netAdrCents, netRevpanCents: none || k.netIncomplete ? null : k.netRevpanCents,
    netStatus: k.netStatus, netIncomplete: k.netIncomplete,
  };
};

export type SnapshotInput = {
  month: string; now: Date;
  property: { id: string; name: string; isDemo: boolean };
  current: MonthKpi; previous: MonthKpi | null;
  /** Occupation moyenne du marché sur le mois, nombre de jours renseignés ; null si moins de la moitié du mois est connue. */
  market: { occupancy: number | null; days: number };
  actions: ReportAction[];
  decisions: { total: number; noAction: number; rejected: number; approved: number };
  open: ReportSnapshot["open"];
};

export function buildSnapshot(i: SnapshotInput): ReportSnapshot {
  const cur = toKpis(i.current), prev = i.previous ? toKpis(i.previous) : null;
  const both = (a: number | null, b: number | null, partial: boolean) => (partial ? "inconnue" as Trend : trendOf(a, b));
  const netPartial = !prev || cur.netIncomplete || prev.netIncomplete;
  const trends = {
    net: both(cur.netCents, prev?.netCents ?? null, netPartial),
    occupancy: trendOf(cur.occupancy, prev?.occupancy ?? null),
    netAdr: both(cur.netAdrCents, prev?.netAdrCents ?? null, netPartial),
    netRevpan: both(cur.netRevpanCents, prev?.netRevpanCents ?? null, netPartial),
  };
  const netTotal = Object.values(i.current.byChannel).reduce((a, b) => a + b, 0);
  const channels = Object.entries(i.current.byChannel).sort((a, b) => b[1] - a[1]).map(([channel, netCents]) => ({ channel, label: CHANNEL_LABEL[channel] ?? channel, netCents, share: netTotal > 0 ? netCents / netTotal : null }));
  const outcomes = Object.fromEntries(OUTCOMES.map((o) => [o, i.actions.filter((a) => a.outcome === o).length])) as Record<Outcome, number>;
  const mo = i.market.occupancy;
  return {
    version: 1, month: i.month, generatedAt: i.now.toISOString(), property: i.property, kpis: cur,
    previous: prev && i.previous ? { month: i.previous.month, kpis: prev } : null, trends, channels,
    market: { occupancy: mo, gapPts: mo !== null && cur.occupancy !== null ? Math.round((cur.occupancy - mo) * 100) : null, days: i.market.days },
    actions: i.actions, outcomes, decisions: i.decisions, open: i.open, unknowns: { contribution: UNKNOWN_CONTRIBUTION, objective: UNKNOWN_OBJECTIVE },
  };
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n > 1 ? many : one}`;

/**
 * Texte du rapport, assemblé par règles : faits marquants et tendances nommées d'abord (pas tous les chiffres). Chaque nombre cité vient de l'instantané.
 * Paragraphes séparés par une ligne vide.
 */
export function draftNarrative(s: ReportSnapshot): string {
  const k = s.kpis, m = fmtMonth(s.month), pm = s.previous ? fmtMonth(s.previous.month) : null;
  const out: string[] = [];
  if (k.nights === 0) out.push(`Aucune nuit vendue en ${m} sur ${s.property.name} : le rapport ne peut pas établir de performance. Aucun chiffre n'est estimé à la place.`);
  else {
    const perf = [`En ${m}, ${plural(k.nights, "nuit vendue", "nuits vendues")} sur ${k.available} disponibles (occupation ${pct(k.occupancy)}).`];
    if (k.netCents === null) perf.push("Le revenu net est inconnu : aucune commission n'est connue sur les nuits vendues.");
    else perf.push(`Le revenu net est de ${euro(k.netCents)}${k.netIncomplete ? ", partiel (la commission est inconnue sur certaines nuits vendues, qui ne sont pas comptées)" : ""}${pm ? `, tendance ${s.trends.net} par rapport à ${pm}` : ""}.`);
    if (k.netRevpanCents !== null && pm) perf.push(`Le revenu net par nuit disponible est de ${euro(k.netRevpanCents)}, tendance ${s.trends.netRevpan}.`);
    out.push(perf.join(" "));
    if (s.channels.length) out.push(`Canaux : ${s.channels.slice(0, 3).map((c) => `${c.label}${c.share === null ? "" : ` ${pct(c.share)}`}`).join(", ")} du revenu net connu.`);
  }
  out.push(s.market.gapPts === null || s.market.occupancy === null
    ? "L'écart au marché est inconnu sur ce mois (occupation du marché non relevée sur assez de jours)."
    : `L'occupation du marché était de ${pct(s.market.occupancy)} : écart de ${s.market.gapPts > 0 ? "+" : s.market.gapPts < 0 ? "−" : ""}${Math.abs(s.market.gapPts)} points pour le logement.`);
  if (s.actions.length === 0) out.push("Aucune action n'a été mesurée ce mois-ci.");
  else {
    const parts = OUTCOMES.filter((o) => s.outcomes[o] > 0).map((o) => `${s.outcomes[o]} ${OUTCOME_LABEL[o].toLowerCase()}${s.outcomes[o] > 1 ? "s" : ""}`);
    out.push(`${plural(s.actions.length, "action mesurée", "actions mesurées")} ce mois-ci : ${parts.join(", ")}. Sans période témoin, aucun effet n'est attribué aux actions : les résultats décrivent ce qui s'est passé après elles.`);
  }
  const d = s.decisions;
  out.push(`${plural(d.total, "décision enregistrée", "décisions enregistrées")} sur le mois${d.total ? `, dont ${plural(d.noAction, "inaction retenue", "inactions retenues")}` : ""}. ${s.open.length === 0 ? "Aucune situation n'est ouverte." : `${plural(s.open.length, "situation ouverte", "situations ouvertes")} à décider${s.open.some((o) => o.veto) ? ", dont certaines sous veto" : ""}.`}`);
  out.push(`${s.unknowns.contribution} ${s.unknowns.objective}`);
  return out.join("\n\n");
}

/* ---------- Garde-fou : aucun nombre hors des métriques certifiées ---------- */

/** Texte ramené à une écriture unique : formes de compatibilité (chiffres pleine chasse), toutes les espaces Unicode, apostrophes entre chiffres comme séparateur de milliers. */
const normalize = (t: string) => t.normalize("NFKC").replace(/\p{Zs}/gu, " ").replace(/(?<=\d)['’](?=\d)/g, " ");
/** Groupes de milliers de trois chiffres (« 1 234,5 »), sinon suite de chiffres avec décimales éventuelles. */
const NUM = /\d{1,3}(?: \d{3})+(?:,\d+)?|\d+(?:[.,]\d+)*/g;
/** « 1 234,5 » → 1234.5 ; « 12,5 » → 12.5 ; « 2026 » → 2026. Un séparateur de milliers n'est jamais pris pour une virgule décimale. */
export function parseNumber(token: string): number | null {
  const t = normalize(token).trim();
  const dec = /[.,](\d{1,2})$/.exec(t);
  const intPart = dec ? t.slice(0, t.length - dec[0].length) : t;
  const digits = intPart.replace(/[ .,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  const v = Number(digits + (dec ? "." + dec[1] : ""));
  return Number.isFinite(v) ? v : null;
}
/** Nombres d'un texte, tels qu'écrits, avec leur valeur, leur position de fin et l'unité qui suit (« € », « % » ou rien). */
export function numbersIn(text: string): { raw: string; value: number; unit: "€" | "%" | "" }[] {
  const t = normalize(text), out: { raw: string; value: number; unit: "€" | "%" | "" }[] = [];
  for (const m of t.matchAll(NUM)) {
    const raw = m[0].replace(/[ .,]+$/g, ""), v = parseNumber(raw);
    if (v === null) continue;
    const after = t.slice((m.index ?? 0) + m[0].length).trimStart();
    out.push({ raw, value: v, unit: /^(€|euros?\b)/i.test(after) ? "€" : after.startsWith("%") ? "%" : "" });
  }
  return out;
}
/** Nombres écrits en lettres : impossibles à rattacher à une métrique, donc refusés (« un » et « une » restent permis). */
const WORD_NUMBERS = /(?<![\p{L}])(deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|vingt|trente|quarante|cinquante|soixante|cent|mille|millions?|milliards?|moitié|double|triple|tiers|quart)s?(?![\p{L}])/giu;
const variants = (v: number): number[] => {
  const out = new Set<number>();
  for (const x of [v, v / 100, v * 100]) { out.add(x); out.add(Math.round(x)); out.add(Math.round(x * 10) / 10); out.add(Math.round(x * 100) / 100); out.add(Math.abs(x)); out.add(Math.abs(Math.round(x))); }
  return [...out];
};
/** Ensemble des valeurs certifiées : toute valeur numérique de l'instantané (centimes, ratios et pourcentages compris, arrondis usuels) et les nombres de ses textes certifiés. */
export function certifiedValues(s: ReportSnapshot): Set<number> {
  const set = new Set<number>();
  const add = (v: number) => { if (Number.isFinite(v)) for (const x of variants(v)) set.add(x); };
  const walk = (x: unknown, key = "") => {
    if (typeof x === "number") add(x);
    else if (typeof x === "string") { if (key !== "generatedAt") for (const n of numbersIn(x)) add(n.value); }
    else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk({ ...s, generatedAt: undefined });
  // le mois (année et numéro) et la date du jour de génération sont des repères de lecture, pas des métriques
  const [y, mo] = s.month.split("-").map(Number); add(y); add(mo);
  if (s.previous) { const [py, pmo] = s.previous.month.split("-").map(Number); add(py); add(pmo); }
  return set;
}
/** Valeurs admises selon l'unité : un montant en euros se compare aux centimes ÷ 100, un pourcentage aux ratios × 100 ; sans unité, toute valeur de l'instantané. */
function contextValues(s: ReportSnapshot): { money: Set<number>; pct: Set<number> } {
  const money = new Set<number>(), pctSet = new Set<number>();
  const addAll = (set: Set<number>, v: number) => { for (const x of [v, Math.round(v), Math.round(v * 10) / 10, Math.round(v * 100) / 100]) set.add(x); };
  const walk = (x: unknown, key = "") => {
    if (typeof x === "number" && Number.isFinite(x)) {
      if (/Cents$/.test(key)) addAll(money, x / 100);
      else if (/^(occupancy|share)$/.test(key)) addAll(pctSet, x * 100);
      else if (key === "gapPts") { addAll(pctSet, x); addAll(pctSet, Math.abs(x)); }
    } else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk({ ...s, generatedAt: undefined });
  return { money, pct: pctSet };
}
/** Nombres du texte qui ne figurent pas dans l'instantané (à corriger avant de certifier) : chiffres non latins et nombres en lettres compris. */
export function findUncertifiedNumbers(text: string, s: ReportSnapshot): string[] {
  const ok = certifiedValues(s), ctx = contextValues(s);
  const bad: string[] = [];
  const flag = (x: string) => { if (!bad.includes(x)) bad.push(x); };
  for (const n of numbersIn(text)) {
    // un montant ou un pourcentage doit venir d'une métrique de même nature ; le nombre peut aussi être cité tel quel dans un texte certifié (résumé d'une mesure)
    const typed = n.unit === "€" ? ctx.money : n.unit === "%" ? ctx.pct : null;
    const good = typed ? typed.has(n.value) || textNumbers(s).has(n.value) : ok.has(n.value);
    if (!good) flag(n.raw);
  }
  for (const m of normalize(text).matchAll(/[\p{Nd}]+/gu)) if (/[^0-9]/.test(m[0])) flag(m[0]);
  for (const m of normalize(text).matchAll(WORD_NUMBERS)) flag(m[0].toLowerCase());
  return bad;
}
/** Nombres écrits dans les textes certifiés de l'instantané (résumés et interprétations des mesures, titres). */
function textNumbers(s: ReportSnapshot): Set<number> {
  const set = new Set<number>();
  const walk = (x: unknown, key = "") => {
    if (typeof x === "string") { if (key !== "generatedAt") for (const n of numbersIn(x)) set.add(n.value); }
    else if (Array.isArray(x)) x.forEach((y) => walk(y, key));
    else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
  };
  walk({ ...s, generatedAt: undefined });
  return set;
}

/** Mots qui attribueraient un effet aux actions : rien ne le permet sans période témoin. */
const CAUSAL = /(grâce à|grace à|à cause (de|des) |a permis|ont permis|a généré|ont généré|a rapporté|ont rapporté|dû à nos|due à nos|résultat de nos|fruit de nos)/i;
/** Phrases d'inconnues qui doivent rester dans le texte, quoi qu'on retouche. */
export function requiredPhrases(s: ReportSnapshot): { phrase: string; why: string }[] {
  const out = [
    { phrase: "Contribution non calculée", why: "la contribution n'est pas suivie" },
    { phrase: "Écart à l'objectif inconnu", why: "aucun objectif chiffré n'est renseigné" },
  ];
  if (s.actions.length > 0) out.push({ phrase: "aucun effet n'est attribué", why: "sans période témoin, aucun effet n'est attribué aux actions" });
  if (s.kpis.netIncomplete && s.kpis.nights > 0) out.push({ phrase: "partiel", why: "le revenu net est partiel ce mois-ci" });
  return out;
}

export const MAX_NARRATIVE = 6000;
export type NarrativeCheck = { ok: true; text: string } | { ok: false; error: string; numbers?: string[] };
/** Texte du rapport : non vide, borné (jamais tronqué), sans nombre hors instantané. */
export function checkNarrative(raw: string, s: ReportSnapshot): NarrativeCheck {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return { ok: false, error: "Le texte du rapport est vide." };
  if (text.length > MAX_NARRATIVE) return { ok: false, error: `Le texte est trop long (${MAX_NARRATIVE} caractères au plus).` };
  if (CAUSAL.test(text)) return { ok: false, error: "Le texte attribue un effet aux actions (« grâce à », « a permis », « a généré »…) : sans période témoin, le rapport décrit ce qui s'est passé, pas ce que les actions ont causé." };
  const missing = requiredPhrases(s).filter((r) => !text.toLowerCase().includes(r.phrase.toLowerCase()));
  if (missing.length) return { ok: false, error: `Le texte doit garder la mention « ${missing[0].phrase} » : ${missing[0].why}.` };
  const numbers = findUncertifiedNumbers(text, s);
  if (numbers.length) return { ok: false, numbers, error: `Ces nombres ne figurent pas dans les métriques certifiées du rapport : ${numbers.join(", ")}. Retirez-les ou régénérez le rapport.` };
  return { ok: true, text };
}

/** Mois ouverts à un rapport : les mois civils terminés, du plus récent au plus ancien, sur 24 mois. */
export function reportableMonths(today: ISODate, n = 24): string[] {
  let [y, m] = today.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) { m -= 1; if (m === 0) { m = 12; y -= 1; } out.push(`${y}-${String(m).padStart(2, "0")}`); }
  return out;
}
export const isReportableMonth = (month: string, today: ISODate, n = 24) => reportableMonths(today, n).includes(month);
