/** Rapport certifié mis en page pour le PDF (US-113). Module pur : mêmes chiffres que l'écran, rien de recalculé. */
import { fmtMonth } from "../dates";
import { OUTCOME_LABEL, OUTCOME_REASON_LABEL, type OutcomeReason } from "../experiments/outcome";
import { euro, pct } from "../format";
import { stampDay, type ExportedReport } from "./csv";
import { buildPdf, type Block } from "./pdf";

const tr = (t: string) => (t === "inconnue" ? "tendance inconnue" : `tendance ${t}`);

export function reportBlocks(r: ExportedReport): Block[] {
  const s = r.snapshot, k = s.kpis, certified = r.status === "CERTIFIED";
  const b: Block[] = [
    { kind: "title", text: `${s.property.name} — ${fmtMonth(r.month)}` },
    { kind: "small", text: `Rapport mensuel ${certified ? "certifié" : "(brouillon, non certifié)"} · version ${r.version}${certified && r.certifiedAt ? ` · certifié le ${stampDay(r.certifiedAt)} par ${r.certifiedByName ?? "—"}` : ""}` },
    { kind: "small", text: `Chiffres lus le ${stampDay(new Date(s.generatedAt))} (heure de Paris).${r.certifiedHash ? ` Empreinte du contenu : ${r.certifiedHash.slice(0, 16)}.` : ""}` },
    { kind: "heading", text: "Métriques du mois" },
    { kind: "row", label: "Revenu net", value: `${k.netCents === null ? "inconnu" : euro(k.netCents)} (${tr(s.trends.net)})${k.netIncomplete && k.netCents !== null ? " — partiel : commission inconnue sur certaines nuits" : ""}` },
    { kind: "row", label: "Occupation", value: `${k.occupancy === null ? "inconnue" : pct(k.occupancy)} (${tr(s.trends.occupancy)}) — ${k.nights} nuits vendues sur ${k.available}` },
    { kind: "row", label: "Prix moyen net", value: `${k.netAdrCents === null ? "inconnu" : euro(k.netAdrCents)} par nuit occupée (${tr(s.trends.netAdr)})` },
    { kind: "row", label: "Revenu net par nuit disponible", value: `${k.netRevpanCents === null ? "inconnu" : euro(k.netRevpanCents)} (${tr(s.trends.netRevpan)})` },
    { kind: "row", label: "Marché", value: s.market.occupancy === null || s.market.gapPts === null ? "écart au marché inconnu" : `occupation du marché ${pct(s.market.occupancy)}, écart ${s.market.gapPts > 0 ? "+" : s.market.gapPts < 0 ? "−" : ""}${Math.abs(s.market.gapPts)} points` },
    { kind: "row", label: "Canaux", value: s.channels.length ? s.channels.map((c) => `${c.label}${c.share === null ? "" : ` ${pct(c.share)}`}`).join(", ") : "répartition inconnue" },
    { kind: "row", label: "Effet incrémental", value: "inconnu — sans période témoin, le rapport décrit ce qui s'est passé, pas ce que les actions ont causé" },
    { kind: "heading", text: "Rapport" },
    ...r.narrative.split(/\n{2,}/).filter((p) => p.trim()).map((p): Block => ({ kind: "para", text: p.trim() })),
    { kind: "heading", text: "Actions mesurées ce mois-ci" },
  ];
  if (s.actions.length === 0) b.push({ kind: "para", text: "Aucune action mesurée ce mois-ci." });
  for (const a of s.actions) {
    b.push({ kind: "row", label: a.code, value: `${a.label} — ${OUTCOME_LABEL[a.outcome]}${a.reasons.length ? ` (${a.reasons.map((x) => OUTCOME_REASON_LABEL[x as OutcomeReason] ?? x).join(" ; ")})` : ""}` });
    b.push({ kind: "small", text: `${a.summary} ${a.interpretation}` });
  }
  return b;
}
export const reportPdf = (r: ExportedReport): Buffer => buildPdf(reportBlocks(r), { title: `Rapport mensuel ${r.month} — ${r.snapshot.property.name}`, footer: "NuitSignal" });
