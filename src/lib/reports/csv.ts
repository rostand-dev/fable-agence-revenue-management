/**
 * Exports CSV (US-113). Module pur. Format pensé pour Excel en français : séparateur « ; », fins de ligne CRLF, BOM UTF-8.
 * Une cellule qui commencerait par = + - @ (ou une tabulation) serait lue comme une formule par un tableur : elle est précédée d'une apostrophe.
 * Une valeur inconnue s'exporte « inconnu », jamais 0 ni cellule vide trompeuse.
 */
import { OUTCOME_LABEL, OUTCOME_REASON_LABEL, type Outcome, type OutcomeReason } from "../experiments/outcome";
import { fmtMonth } from "../dates";
import type { ReportSnapshot } from "./monthly";

export const BOM = "﻿";
export type Cell = string | number | boolean | null | undefined;

/** Neutralise l'injection de formule, puis met entre guillemets si besoin. */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return "";
  let t = typeof v === "number" ? (Number.isFinite(v) ? String(v).replace(".", ",") : "") : String(v);
  t = t.replace(/\r\n|\r|\n/g, " ⏎ ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  if (/^[=+\-@\t]/.test(t) && !/^-?\d+(?:,\d+)?$/.test(t)) t = "'" + t;
  return /[";]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}
export const toCsv = (rows: Cell[][]): string => BOM + rows.map((r) => r.map(csvCell).join(";")).join("\r\n") + "\r\n";

const UNK = "inconnu";
const FMT = new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const parts = (d: Date) => Object.fromEntries(FMT.formatToParts(d).map((p) => [p.type, p.value]));
/** Jour (AAAA-MM-JJ) et horodatage (AAAA-MM-JJ HH:MM) en heure de Paris, comme à l'écran. */
export const stampDay = (d: Date): string => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
export const stamp = (d: Date): string => { const p = parts(d); return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`; };
const eur = (c: number | null) => (c === null ? UNK : Math.round(c) / 100);
const ratio = (x: number | null) => (x === null ? UNK : Math.round(x * 1000) / 10);

export type ExportedReport = { month: string; version: number; status: string; narrative: string; certifiedAt: Date | null; certifiedByName: string | null; certifiedHash: string | null; snapshot: ReportSnapshot };

/** Un rapport certifié, lisible en tableur : en-tête, métriques (valeur, unité, tendance), canaux, actions mesurées, texte. */
export function reportCsv(r: ExportedReport): string {
  const s = r.snapshot, k = s.kpis;
  const rows: Cell[][] = [
    ["Rapport mensuel certifié"],
    ["Logement", s.property.name],
    ["Mois", fmtMonth(r.month)],
    ["Version", r.version],
    ["État", r.status === "CERTIFIED" ? "Certifié" : "Brouillon"],
    ["Certifié le", r.certifiedAt ? stamp(r.certifiedAt) : UNK],
    ["Certifié par", r.certifiedByName ?? UNK],
    ["Empreinte du contenu", r.certifiedHash ?? UNK],
    ["Chiffres lus le", stamp(new Date(s.generatedAt))],
    ["Heures", "heure de Paris"],
    [],
    ["Métrique", "Valeur", "Unité", "Tendance"],
    ["Nuits vendues", k.nights, "nuits", ""],
    ["Nuits disponibles", k.available, "nuits", ""],
    ["Occupation", ratio(k.occupancy), "%", s.trends.occupancy],
    ["Revenu net", eur(k.netCents), "€", s.trends.net],
    ["Revenu net complet", k.netIncomplete ? "non : commission inconnue sur certaines nuits vendues, leur revenu n'est pas compté (revenu net sous-évalué)" : "oui", "", ""],
    ["Prix moyen net par nuit occupée", eur(k.netAdrCents), "€", s.trends.netAdr],
    ["Revenu net par nuit disponible", eur(k.netRevpanCents), "€", s.trends.netRevpan],
    ["Occupation du marché", ratio(s.market.occupancy), "%", ""],
    ["Écart au marché", s.market.gapPts === null ? UNK : s.market.gapPts, "points", ""],
    ["Effet incrémental des actions", UNK, "", "sans période témoin"],
    ["Contribution", UNK, "", "coûts variables non suivis"],
    ["Écart à l'objectif", UNK, "", "aucun objectif renseigné"],
    [],
    ["Canal", "Revenu net (€)", "Part du net connu (%)", "Remarque"],
    ...s.channels.map((c): Cell[] => [c.label, eur(c.netCents), ratio(c.share), k.netIncomplete ? "net partiel" : ""]),
    [],
    ["Dossier", "Action", "Résultat", "Motifs", "Observé", "Interprétation"],
    ...s.actions.map((a): Cell[] => [a.code, a.label, OUTCOME_LABEL[a.outcome], a.reasons.map((x) => OUTCOME_REASON_LABEL[x as OutcomeReason] ?? x).join(" · "), a.summary, a.interpretation]),
    [],
    ["Texte du rapport"],
    ...r.narrative.split(/\n{2,}/).filter((p) => p.trim()).map((p): Cell[] => [p]),
  ];
  return toCsv(rows);
}

export type HistoryRow = { month: string; version: number; status: string; certifiedAt: Date | null; certifiedByName: string | null; certifiedHash: string | null };
/** Historique des rapports d'un logement : une ligne par version. */
export function historyCsv(propertyName: string, rows: HistoryRow[]): string {
  return toCsv([
    ["Logement", "Mois", "Version", "État", "Certifié le (heure de Paris)", "Certifié par", "Empreinte du contenu"],
    ...rows.map((r): Cell[] => [propertyName, `${r.month}-01`, r.version, r.status === "CERTIFIED" ? "Certifié" : "Brouillon", r.certifiedAt ? stamp(r.certifiedAt) : "", r.certifiedByName ?? "", r.certifiedHash ?? ""]),
  ]);
}

export type MeasureRow = { id: string; code: string; label: string; outcome: Outcome; reasons: string[]; observeFrom: string | null; observeTo: string | null; summary: string; interpretation: string; confidence: string; legacy: boolean; measuredAt: Date };
/** Historique des mesures d'expériences d'un logement : une ligne par action mesurée. */
export function measuresCsv(propertyName: string, rows: MeasureRow[]): string {
  return toCsv([
    ["Logement", "Dossier", "Action", "Résultat", "Motifs", "Observation du", "au (exclu)", "Observé", "Interprétation", "Confiance", "Mesure héritée", "Mesuré le (heure de Paris)", "Lecture"],
    ...rows.map((m): Cell[] => [propertyName, m.code, m.label, OUTCOME_LABEL[m.outcome], m.reasons.map((x) => OUTCOME_REASON_LABEL[x as OutcomeReason] ?? x).join(" · "), m.observeFrom ?? UNK, m.observeTo ?? UNK, m.summary, m.interpretation, m.confidence, m.legacy ? "oui" : "non", stamp(m.measuredAt), "observation après l'action, sans période témoin : aucun effet n'est attribué"]),
  ]);
}
