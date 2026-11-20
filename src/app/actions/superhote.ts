"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { confirmPasswordIfNeeded } from "@/lib/reauth";
import { SyncError } from "@/lib/services/pricelabs-sync";
import { runDailyReview } from "@/lib/services/review";
import { connectSuperhote, detachRental, disconnectSuperhote, selectRental, syncSuperhote } from "@/lib/services/superhote-sync";

/** `sensitive` : formulaire d'une action qui touche à une clé API ; une session rétablie par « Rester connecté » doit d'abord confirmer le mot de passe. */
async function run(fn: (u: { id: string; tenantId: string }) => Promise<string | void>, sensitive?: FormData): Promise<FormState> {
  const u = await requireUser();
  if (sensitive) { const refused = await confirmPasswordIfNeeded(u, sensitive); if (refused) return refused; }
  let ok: string | void;
  try { ok = await fn(u); } catch (e) { if (e instanceof SyncError) return { error: e.message }; console.error("[superhote]", e instanceof Error ? e.message : e); return { error: "Erreur technique. Rien n'a été modifié." }; }
  revalidatePath("/", "layout");
  return ok ? { ok } : null;
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function connectSuperhoteAction(_: FormState, fd: FormData) {
  return run(async (u) => { const r = await connectSuperhote(u.tenantId, s(fd, "propertyId"), s(fd, "apiKey"), "user:" + u.id); return `Jeton vérifié : ${r.rentals} logement${r.rentals > 1 ? "s" : ""} visible${r.rentals > 1 ? "s" : ""}. Confirmez celui de ce logement.`; }, fd);
}
export async function selectRentalAction(_: FormState, fd: FormData) {
  return run(async (u) => { await selectRental(u.tenantId, s(fd, "propertyId"), s(fd, "rentalId"), "user:" + u.id); await runDailyReview(u.tenantId, "MANUAL"); return "Logement rattaché et première lecture effectuée."; });
}
export async function detachRentalAction(_: FormState, fd: FormData) {
  return run(async (u) => { await detachRental(u.tenantId, s(fd, "propertyId"), "user:" + u.id); return "Logement détaché. Choisissez celui de ce logement."; });
}
export async function syncSuperhoteAction(_: FormState, fd: FormData) {
  return run(async (u) => { const r = await syncSuperhote(u.tenantId, s(fd, "propertyId")); await runDailyReview(u.tenantId, "MANUAL"); return `Lecture terminée : ${r.reservations} réservations et ${r.nights} nuits de calendrier lues. Revue relancée.`; });
}
export async function disconnectSuperhoteAction(_: FormState, fd: FormData) {
  return run(async (u) => { await disconnectSuperhote(u.tenantId, s(fd, "propertyId"), "user:" + u.id); return "Jeton supprimé."; }, fd);
}
