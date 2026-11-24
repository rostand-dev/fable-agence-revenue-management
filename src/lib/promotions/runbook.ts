/**
 * Guide pas-à-pas d'une action appliquée à la main (US-102, blueprint Annexe B).
 *
 * Module pur : à partir de l'action approuvée (type, canal, paramètres, prix simulé), il produit la liste ordonnée des étapes que l'opérateur
 * suit dans l'extranet. Les identifiants d'étape sont STABLES (ils servent à enregistrer ce qui a été fait) ; le texte, lui, peut évoluer.
 * Aucune automatisation : le guide dit quoi faire, la personne le fait et le coche.
 */
import { fmtDay } from "../dates";
import { CHANNEL_LABEL } from "../engine/types";
import { euro } from "../format";
import { promoKind } from "../stacking/rules";
import { AUDIENCE_LABEL, audienceOfKind } from "./registry";

export type StepKind = "OPEN" | "CHECK" | "DO" | "COMPARE" | "CAPTURE" | "STOP";
/** `checkable: false` : consigne de sécurité, lue mais pas cochée (elle ne compte pas dans l'avancement). */
export type RunbookStep = { id: string; kind: StepKind; title: string; detail?: string; checkable: boolean;
  /** Consigne d'arrêt : tant qu'elle est là, le guide ne peut pas être « terminé » (ne rien poser, demander une décision) */
  blocking?: boolean };
export type RunbookInput = {
  type: string; channel: string | null; label: string;
  parameters: Record<string, any>;
  /** Prix vendu par nuit attendu, d'après la simulation approuvée */
  soldNightlyCents: number | null;
};

const SAFETY: RunbookStep = { id: "stop-if-different", kind: "STOP", checkable: false, title: "Si l'état réel diffère de ce qui est approuvé : s'arrêter.", detail: "Ne rien improviser : n'appliquez rien de différent de ce qui est approuvé, et consignez l'écart dans la portée de la déclaration ci-dessous." };

const where = (channel: string | null) => channel === "BOOKING" ? "l'extranet Booking.com" : channel === "AIRBNB" ? "votre compte hôte Airbnb" : "l'extranet officiel du canal";
const price = (c: number | null) => (c == null ? null : `${euro(c)} la nuit`);
const period = (p: Record<string, any>) => (p.stayFrom && p.stayTo ? `séjours du ${fmtDay(p.stayFrom)} au ${fmtDay(p.stayTo)}` : "séjours selon la portée du dossier");

export function buildRunbook(i: RunbookInput): RunbookStep[] {
  const ch = i.channel ? CHANNEL_LABEL[i.channel] ?? i.channel : null;
  const open: RunbookStep = { id: "open", kind: "OPEN", checkable: true, title: `Ouvrir ${where(i.channel)} depuis votre navigateur, connecté à votre compte.`, detail: "NuitSignal n'écrit jamais chez le canal : vous appliquez vous-même." };
  switch (i.type) {
    case "CHANNEL_PROMO": {
      const kind = String(i.parameters.kind ?? "").toUpperCase();
      const def = i.channel ? promoKind(i.channel, kind) : undefined;
      const steps: RunbookStep[] = [];
      const pct = Number(i.parameters.discountPct);
      if (!Number.isFinite(pct) || pct <= 0) steps.push({ id: "missing-discount", kind: "STOP", checkable: false, blocking: true, title: "Remise absente du dossier : ne rien poser.", detail: "L'action approuvée ne porte pas de remise exploitable. Demandez qu'elle soit corrigée plutôt que d'en supposer une." });
      if (!def) steps.push({ id: "unknown-type", kind: "STOP", checkable: false, blocking: true, title: "Type de promotion absent du registre de cumul : ne rien poser.", detail: `Le type « ${kind || "?"} » n'est pas connu pour ${ch ?? "ce canal"} : l'éligibilité et le cumul ne sont pas établis. Demandez une décision humaine.` });
      const facts = [
        ...(def || kind ? [`Type : ${def?.label ?? kind}`] : []),
        ...(Number.isFinite(pct) && pct > 0 ? [`Remise : ${pct} %`] : []),
        `Séjours : ${i.parameters.stayFrom && i.parameters.stayTo ? `du ${fmtDay(i.parameters.stayFrom)} au ${fmtDay(i.parameters.stayTo)} (départ exclu)` : "selon la portée du dossier"}`,
        ...(i.parameters.minLos ? [`Séjour minimal : ${i.parameters.minLos} nuits`] : []),
        ...(def && audienceOfKind(kind) !== "ALL" ? [`Audience : ${AUDIENCE_LABEL[audienceOfKind(kind)]}`] : []),
      ];
      steps.push(
        open,
        { id: "check-scope", kind: "CHECK", checkable: true, title: "Vérifier le logement, l'annonce et les dates de séjour.", detail: "Fuseau horaire compris : une promotion décalée d'un jour est une promotion fausse." },
        { id: "check-active", kind: "CHECK", checkable: true, title: "Contrôler les promotions déjà actives et les comparer au registre.", detail: "Une promotion visant le même signal ne se superpose pas à celle-ci sans test approuvé. Corrigez le registre si l'extranet dit autre chose." },
        { id: "create", kind: "DO", checkable: true, title: `Créer la promotion « ${i.parameters.label ?? i.label} ».`, detail: facts.join(" · ") },
        { id: "compare-price", kind: "COMPARE", checkable: true, title: "Comparer le prix final affiché à la simulation.", detail: price(i.soldNightlyCents) ? `Attendu : ${price(i.soldNightlyCents)}.` : "La simulation de l'action ne donne pas de prix : relisez-la avant d'appliquer." },
        { id: "capture", kind: "CAPTURE", checkable: true, title: "Relever l'identifiant ou la confirmation de la promotion.", detail: "Notez l'identifiant affiché par le canal, ou gardez une capture : vous les saisirez dans la déclaration ci-dessous." },
        SAFETY,
      );
      return steps;
    }
    case "PROMO_REMOVAL":
      return [
        { ...open, title: `Ouvrir ${where(i.channel)}, rubrique promotions.` },
        { id: "find", kind: "CHECK", checkable: true, title: `Repérer la promotion « ${i.parameters.promotionLabel ?? i.label} » et vérifier ses dates.`, detail: period(i.parameters) },
        { id: "disable", kind: "DO", checkable: true, title: "La désactiver pour les dates du dossier uniquement.", detail: "Laissez les autres promotions en l'état." },
        { id: "compare-price", kind: "COMPARE", checkable: true, title: "Contrôler le prix final affiché.", detail: price(i.soldNightlyCents) ? `Attendu : ${price(i.soldNightlyCents)}.` : undefined },
        { id: "capture", kind: "CAPTURE", checkable: true, title: "Relever la date et la référence de confirmation.", detail: "Elles sont demandées dans la déclaration ci-dessous." },
        SAFETY,
      ];
    case "INVESTIGATION":
      return [
        { ...open, title: `Ouvrir ${where(i.channel)}, rubrique promotions.` },
        { id: "list", kind: "CHECK", checkable: true, title: "Relever chaque promotion active : type, taux, dates de séjour.", detail: `Le registre en attend ${(i.parameters.promotions ?? []).length}.` },
        { id: "gaps", kind: "CHECK", checkable: false, title: "Signaler tout écart avec le registre dans le champ de portée ci-dessous." },
        { id: "declare", kind: "CAPTURE", checkable: false, title: "Déclarer la vérification ci-dessous : le registre est alors horodaté à aujourd'hui." },
      ];
    case "LISTING_AUDIT":
      return [
        { id: "read", kind: "CHECK", checkable: true, title: "Relire titre, description et photos de chaque annonce." },
        { id: "amenities", kind: "CHECK", checkable: true, title: "Comparer les équipements déclarés à ceux du logement." },
        { id: "reviews", kind: "CHECK", checkable: true, title: "Relire les avis des 90 derniers jours et noter tout frein récurrent." },
        { id: "notes", kind: "CAPTURE", checkable: false, title: "Consigner les corrections retenues dans la déclaration ci-dessous." },
      ];
    default:
      return [
        { id: "open", kind: "OPEN", checkable: true, title: "Ouvrir PriceLabs sur le logement concerné." },
        { id: "apply", kind: "DO", checkable: true, title: `Appliquer : ${i.label}.` },
        { id: "reread", kind: "CHECK", checkable: true, title: "Relire la grille publiée pour les dates du dossier." },
        { id: "declare", kind: "CAPTURE", checkable: false, title: "Déclarer la réalisation ci-dessous." },
      ];
  }
}

export type RunbookProgress = { total: number; done: number; complete: boolean; blocked: boolean };
/** Avancement : seules les étapes à cocher comptent, et seules les étapes connues du guide actuel (une étape retirée depuis n'est plus comptée). */
export function runbookProgress(steps: RunbookStep[], doneIds: Iterable<string>): RunbookProgress {
  const done = new Set(doneIds);
  const checkable = steps.filter((s) => s.checkable);
  const n = checkable.filter((s) => done.has(s.id)).length;
  const blocked = steps.some((s) => s.blocking);
  return { total: checkable.length, done: n, blocked, complete: !blocked && checkable.length > 0 && n === checkable.length };
}
