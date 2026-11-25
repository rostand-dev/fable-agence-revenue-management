import { addDays, type ISODate } from "../dates";
import { PLAYBOOK_CODES, PLAYBOOKS, type PlaybookCode } from "./playbooks";

/**
 * Calibrage des playbooks : ce que disent les dossiers réels sur les seuils. Module pur (aucune lecture de base), lu par la page Méthode.
 * Les seuils du catalogue sont des hypothèses de départ ; ce tableau dit lesquels produisent trop de bruit, lesquels se taisent, et dans quel sens va le volume.
 */
export const CALIBRATION = {
  recentDays: 30,        // fenêtre récente de comparaison du volume de dossiers
  historyDays: 90,       // historique des décisions
  minVolume: 3,          // dossiers (récents + précédents) en dessous desquels la tendance n'est pas lisible
  growthRatio: 1.5,      // volume récent / précédent à partir duquel la tendance est « croissante »
  declineRatio: 2 / 3,   // … et en dessous duquel elle est « décroissante »
  minDecisions: 5,       // approbations + refus minimaux pour parler d'un taux d'approbation
  noisyRejectionRate: 0.6, // part de refus à partir de laquelle le seuil paraît trop sensible
  rubberStampRate: 0.9,    // part d'approbations à partir de laquelle le seuil paraît trop prudent
  rubberStampMinDecisions: 8,
  ignoredRate: 0.6,        // part de dossiers expirés sans réponse à partir de laquelle le signal paraît du bruit
} as const;

export type CalRow = { playbook: string; status: string; decision: string | null; createdAt: Date };
export type Trend = "CROISSANTE" | "STABLE" | "DECROISSANTE" | "INSUFFISANT";
export type Verdict = "SILENCIEUX" | "TROP_SENSIBLE" | "TROP_PRUDENT" | "EN_OBSERVATION" | "IGNORE" | "RAS";
export type CalibrationLine = {
  code: PlaybookCode; label: string; recent: number; previous: number; trend: Trend;
  open: number; expired: number; approved: number; rejected: number; noAction: number; approvalRate: number | null; total: number; verdict: Verdict;
};

const iso = (d: Date): ISODate => d.toISOString().slice(0, 10);

export function trendOf(recent: number, previous: number): Trend {
  if (recent + previous < CALIBRATION.minVolume) return "INSUFFISANT";
  if (previous === 0) return "CROISSANTE";
  const r = recent / previous;
  return r >= CALIBRATION.growthRatio ? "CROISSANTE" : r <= CALIBRATION.declineRatio ? "DECROISSANTE" : "STABLE";
}

export function calibration(rows: CalRow[], today: ISODate): CalibrationLine[] {
  const r30 = addDays(today, -CALIBRATION.recentDays), r60 = addDays(today, -2 * CALIBRATION.recentDays), r90 = addDays(today, -CALIBRATION.historyDays);
  return PLAYBOOK_CODES.filter((c) => PLAYBOOKS[c].status === "IMPLEMENTED").map((code) => {
    const mine = rows.filter((x) => x.playbook === code && iso(x.createdAt) > r90);
    const recent = mine.filter((x) => iso(x.createdAt) > r30).length;
    const previous = mine.filter((x) => iso(x.createdAt) <= r30 && iso(x.createdAt) > r60).length;
    const approved = mine.filter((x) => x.decision === "APPROVED" || x.decision === "APPROVED_SHADOW").length;
    const rejected = mine.filter((x) => x.decision === "REJECTED").length;
    const noAction = mine.filter((x) => x.decision === "NO_ACTION").length;
    const open = mine.filter((x) => x.status === "OPEN").length;
    const expired = mine.filter((x) => x.status === "EXPIRED").length;
    const decided = approved + rejected;
    const approvalRate = decided >= CALIBRATION.minDecisions ? approved / decided : null;
    const verdict: Verdict = mine.length === 0 ? "SILENCIEUX"
      : mine.length >= CALIBRATION.minDecisions && expired / mine.length >= CALIBRATION.ignoredRate ? "IGNORE"
      : approvalRate === null ? "EN_OBSERVATION"
      : 1 - approvalRate >= CALIBRATION.noisyRejectionRate ? "TROP_SENSIBLE"
      : approvalRate >= CALIBRATION.rubberStampRate && decided >= CALIBRATION.rubberStampMinDecisions ? "TROP_PRUDENT" : "RAS";
    return { code, label: PLAYBOOKS[code].label, recent, previous, trend: trendOf(recent, previous), open, expired, approved, rejected, noAction, approvalRate, total: mine.length, verdict };
  });
}

export const VERDICT_TEXT: Record<Verdict, string> = {
  SILENCIEUX: "Aucun dossier en 90 jours : normal si la situation ne s'est pas présentée, seuil à revoir si elle vous paraît fréquente.",
  EN_OBSERVATION: "Pas encore assez de décisions pour juger le seuil.",
  TROP_SENSIBLE: "Souvent refusé : le seuil déclenche probablement trop tôt.",
  TROP_PRUDENT: "Presque toujours approuvé : le seuil est peut-être trop prudent, des cas ont pu passer sous le radar.",
  IGNORE: "Le plus souvent expiré sans réponse : signal peu utile ou mal placé, seuil à revoir.",
  RAS: "Taux d'approbation dans la plage attendue : rien à signaler.",
};
export const TREND_TEXT: Record<Trend, string> = { CROISSANTE: "En hausse", STABLE: "Stable", DECROISSANTE: "En baisse", INSUFFISANT: "Trop peu de dossiers" };
