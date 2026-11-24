/**
 * Actions candidates typées (blueprint §9.1, §11.3, US-063). Chaque type d'action a un contrat : où il s'applique (système cible),
 * comment il s'exécute, quels paramètres il porte et avec quelles bornes. Une candidate qui ne respecte pas son contrat, ou qui n'est pas
 * permise par son playbook (catalogue `playbooks.ts`), n'est jamais proposée : le moteur la retire et le signale.
 * Module pur, sans accès base.
 */
import { playbookOf } from "./playbooks";
import type { Candidate, CandidateType, DetectedOpportunity } from "./types";

type Target = Candidate["target"]["system"];
type Mode = Candidate["executionMode"];
type ParamRule = { key: string; kind: "dates" | "int" | "number" | "string" | "boolean" | "stringList" | "nullableNumber"; min?: number; max?: number };

export type CandidateSpec = {
  label: string;
  /** Systèmes cibles permis. */
  systems: Target[];
  /** Façons d'exécuter permises. */
  modes: Mode[];
  /** Paramètres obligatoires et leurs bornes. */
  params: ParamRule[];
  /** true = l'action touche des nuits précises (au moins une) ; false = aucune nuit n'est touchée. */
  touchesNights: boolean;
  /** true = une action exécutable, qui doit pouvoir être annulée (plan de retour arrière non vide) et mesurée. */
  executable: boolean;
};

const dates: ParamRule = { key: "dates", kind: "dates" };
const CHANNELS: Target[] = ["BOOKING", "AIRBNB"];
/** Sans capacité d'écriture PriceLabs, l'action reste proposée sous forme de procédure manuelle. */
const PL_MODES: Mode[] = ["API_PRICELABS", "MANUAL_RUNBOOK"];

export const CANDIDATE_SPECS: Record<CandidateType, CandidateSpec> = {
  PRICE_OVERRIDE: { label: "Prix daté", systems: ["PRICELABS"], modes: PL_MODES, touchesNights: true, executable: true, params: [dates, { key: "nightlyCents", kind: "int", min: 1 }] },
  MIN_STAY_OVERRIDE: { label: "Séjour minimum daté", systems: ["PRICELABS"], modes: PL_MODES, touchesNights: true, executable: true, params: [dates, { key: "minStay", kind: "int", min: 1, max: 30 }, { key: "previousMinStay", kind: "int", min: 1, max: 365 }] },
  RULE_EXCLUSION: { label: "Exclusion de règle", systems: ["PRICELABS"], modes: PL_MODES, touchesNights: true, executable: true, params: [dates, { key: "rule", kind: "string" }, { key: "nightlyCents", kind: "int", min: 1 }] },
  BASE_PRICE_CHANGE: { label: "Prix de base", systems: ["PRICELABS"], modes: PL_MODES, touchesNights: true, executable: true, params: [dates, { key: "changePct", kind: "number", min: -30, max: 30 }, { key: "basePriceCents", kind: "nullableNumber", min: 1 }] },
  MIN_PRICE_CHANGE: { label: "Prix minimum", systems: ["PRICELABS"], modes: PL_MODES, touchesNights: false, executable: true, params: [{ key: "minPriceCents", kind: "int", min: 1 }, { key: "previousMinPriceCents", kind: "int", min: 1 }] },
  CHANNEL_PROMO: { label: "Promotion de canal", systems: CHANNELS, modes: ["MANUAL_RUNBOOK"], touchesNights: true, executable: true, params: [{ key: "kind", kind: "string" }, { key: "discountPct", kind: "number", min: 1, max: 40 }, { key: "label", kind: "string" }, { key: "stayFrom", kind: "string" }, { key: "stayTo", kind: "string" }] },
  PROMO_REMOVAL: { label: "Retrait de promotion", systems: CHANNELS, modes: ["MANUAL_RUNBOOK"], touchesNights: true, executable: true, params: [{ key: "promotionId", kind: "string" }] },
  LISTING_AUDIT: { label: "Audit d'annonce", systems: ["INTERNAL"], modes: ["NONE", "INTERNAL"], touchesNights: false, executable: false, params: [] },
  INVESTIGATION: { label: "Vérification manuelle", systems: [...CHANNELS, "INTERNAL"], modes: ["MANUAL_RUNBOOK", "NONE", "INTERNAL"], touchesNights: false, executable: false, params: [{ key: "channel", kind: "string" }] },
  NO_ACTION: { label: "Ne rien faire", systems: ["INTERNAL"], modes: ["NONE"], touchesNights: false, executable: false, params: [] },
};

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function checkParam(v: unknown, r: ParamRule): string | null {
  switch (r.kind) {
    case "dates": return Array.isArray(v) && v.length > 0 && v.every((d) => typeof d === "string" && isoDate.test(d)) ? null : "liste de dates ISO non vide attendue";
    case "string": return typeof v === "string" && v.length > 0 ? null : "texte non vide attendu";
    case "boolean": return typeof v === "boolean" ? null : "booléen attendu";
    case "stringList": return Array.isArray(v) && v.every((x) => typeof x === "string") ? null : "liste de textes attendue";
    case "nullableNumber": if (v === null) return null; // fallthrough
    case "int": case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) return "nombre attendu";
      if (r.kind === "int" && !Number.isInteger(v)) return "entier attendu";
      if (r.min !== undefined && v < r.min) return `au moins ${r.min}`;
      if (r.max !== undefined && v > r.max) return `au plus ${r.max}`;
      return null;
    }
  }
}

/** Écarts d'une candidate à son contrat et à son playbook ; liste vide = conforme. */
export function candidateIssues(c: Candidate, playbook: string): string[] {
  const out: string[] = [];
  const spec = CANDIDATE_SPECS[c.type];
  if (!spec) return [`type d'action inconnu : ${c.type}`];
  const pb = playbookOf(playbook);
  if (!pb) out.push(`playbook inconnu : ${playbook}`);
  if (pb && !pb.candidates.includes(c.type)) out.push(`${spec.label} n'est pas une action permise pour ${pb.code}`);
  if (!spec.systems.includes(c.target.system)) out.push(`système cible ${c.target.system} non permis pour ${spec.label}`);
  if (!spec.modes.includes(c.executionMode)) out.push(`mode d'exécution ${c.executionMode} non permis pour ${spec.label}`);
  for (const r of spec.params) { const e = checkParam((c.parameters as Record<string, unknown>)[r.key], r); if (e) out.push(`paramètre ${r.key} : ${e}`); }
  // une remise de durée de séjour sans séjour minimal serait inscrite au registre comme une remise sur tous les séjours
  if (c.type === "CHANNEL_PROMO" && (c.parameters as Record<string, unknown>).kind === "LOS") { const n = (c.parameters as Record<string, unknown>).minLos; if (!Number.isInteger(n) || (n as number) < 2) out.push("paramètre minLos : séjour minimal (entier d'au moins 2 nuits) obligatoire pour une remise de durée de séjour"); }
  if (spec.touchesNights && !(c.nightsTouched > 0)) out.push("une action datée doit toucher au moins une nuit");
  if (!spec.touchesNights && c.nightsTouched !== 0 && c.type !== "LISTING_AUDIT" && c.type !== "INVESTIGATION") out.push("cette action ne touche aucune nuit");
  if (spec.executable) {
    if (!c.rollbackPlan?.trim()) out.push("plan de retour arrière manquant");
    if (!(c.measurementWindowDays > 0)) out.push("fenêtre de mesure manquante");
  }
  if (CHANNELS.includes(c.target.system) && c.target.channel !== c.target.system) out.push("canal cible manquant ou incohérent");
  if (!c.audit || !["APPROVE", "REJECT", "NEEDS_HUMAN"].includes(c.audit.verdict)) out.push("verdict d'audit manquant");
  return out;
}

export type ConformityIssue = { opportunity: string; candidate: string; issues: string[] };

/**
 * Retire les candidates non conformes d'un dossier. Sans candidate restante, le dossier n'est pas proposé, sauf s'il est sous veto (il reste visible). L'option retenue est conservée si elle est
 * conforme ; sinon on retient « ne rien faire » quand il est présent, à défaut la première candidate conforme.
 */
export function conformOpportunity(o: DetectedOpportunity): { opportunity: DetectedOpportunity | null; issues: ConformityIssue[] } {
  const issues: ConformityIssue[] = [];
  const kept: Candidate[] = [];
  let selected = -1;
  o.candidates.forEach((c, i) => {
    const found = candidateIssues(c, o.playbook);
    if (found.length) { issues.push({ opportunity: o.title, candidate: c.label, issues: found }); return; }
    if (i === o.selected) selected = kept.length;
    kept.push(c);
  });
  // un dossier sous veto n'est jamais écarté en silence : un dépassement de plancher doit rester visible, l'écart est signalé au journal
  if (!kept.length) return { opportunity: o.veto ? o : null, issues };
  if (selected < 0) {
    const na = kept.findIndex((c) => c.type === "NO_ACTION");
    const ok = kept.findIndex((c) => c.audit.verdict !== "REJECT");
    selected = na >= 0 ? na : ok >= 0 ? ok : 0;
  }
  return { opportunity: issues.length ? { ...o, candidates: kept, selected } : o, issues };
}
