/**
 * Confirmation opérateur d'une action appliquée à la main (US-103, blueprint §10.3 et Annexe B).
 *
 * « En V1, une promotion appliquée manuellement doit être confirmée par l'opérateur, qui saisit l'identifiant ou joint une preuve et la date d'effet. »
 * Module pur : valide et nettoie ce que la personne déclare. Une référence, une preuve ou une date inventée est refusée, jamais complétée.
 * La preuve est du TEXTE (numéro de confirmation, lien vers une capture) : elle n'est jamais suivie ni interprétée comme une instruction.
 */
import type { ISODate } from "../dates";
import type { Checked } from "./registry";

/** Types d'action dont l'application change le registre : l'identifiant ou une preuve y est obligatoire. */
export const PROOF_REQUIRED_TYPES = ["CHANNEL_PROMO", "PROMO_REMOVAL"] as const;
export const needsProof = (actionType: string): boolean => (PROOF_REQUIRED_TYPES as readonly string[]).includes(actionType);

export type Declaration = { scope: string; date: string; proof: string; externalRef?: string };
export type CleanDeclaration = { scope: string; date: ISODate; proof: string | null; externalRef: string | null };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string) => ISO.test(s) && s >= "2000-01-01" && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const clean = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * `today` et `notBefore` (jour de l'approbation) : jours civils Europe/Paris, fournis par l'appelant. La date d'effet ne peut pas être dans le futur : on confirme ce qui est fait, pas ce qui est prévu.
 */
export function validateDeclaration(actionType: string, raw: Declaration, today: ISODate, notBefore?: ISODate): Checked<CleanDeclaration> {
  if (String(raw.scope ?? "").length > 2000) return { ok: false, error: "La portée déclarée est trop longue (2 000 caractères au plus)." };
  if (String(raw.proof ?? "").length > 1000) return { ok: false, error: "La preuve est trop longue (1 000 caractères au plus) : gardez le numéro de confirmation ou un lien vers la capture." };
  const scope = clean(raw.scope, 2000);
  if (scope.length < 5) return { ok: false, error: "Déclarez la portée réellement appliquée (ce qui a été fait, pas ce qui était prévu)." };
  const date = String(raw.date ?? "").trim();
  if (!validDate(date)) return { ok: false, error: "Indiquez la date d'entrée en vigueur (jour où la promotion a été posée dans l'extranet)." };
  if (date > today) return { ok: false, error: "La date d'entrée en vigueur ne peut pas être dans le futur : confirmez une action déjà faite." };
  if (notBefore && date < notBefore) return { ok: false, error: `La date d'entrée en vigueur ne peut pas précéder l'approbation de l'action (${notBefore}).` };
  const externalRef = clean(raw.externalRef, 121) || null;
  if (externalRef !== null && !/^[\p{L}\p{N} ._:#/\-]{1,120}$/u.test(externalRef)) return { ok: false, error: "L'identifiant relevé dans l'extranet ne peut contenir que des lettres, des chiffres et . _ : # / - (120 caractères au plus)." };
  const proof = clean(raw.proof, 1000) || null;
  if (needsProof(actionType) && !externalRef && !proof) return { ok: false, error: "Saisissez l'identifiant relevé dans l'extranet, ou une preuve (numéro de confirmation, lien vers une capture) : sans cela, la promotion ne peut pas être confirmée." };
  if (proof !== null && proof.length < 3) return { ok: false, error: "La preuve est trop courte pour être utile (numéro de confirmation ou lien vers une capture)." };
  return { ok: true, value: { scope, date, proof, externalRef } };
}

/** Écart constaté entre l'état réel et l'action approuvée : on s'arrête, on explique. */
export function validateMismatch(note: unknown): Checked<string> {
  const n = clean(note, 1000);
  if (n.length < 10) return { ok: false, error: "Décrivez l'écart constaté (ce que dit l'extranet, ce qui était approuvé) en une ou deux phrases." };
  return { ok: true, value: n };
}
