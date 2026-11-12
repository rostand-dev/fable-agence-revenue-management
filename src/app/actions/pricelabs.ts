"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { connectPriceLabs, disconnectPriceLabs, selectListing, SyncError, syncPriceLabs } from "@/lib/services/pricelabs-sync";
import { runDailyReview } from "@/lib/services/review";

async function run(fn: (u: { id: string; tenantId: string }) => Promise<string | void>): Promise<FormState> {
  const u = await requireUser();
  let ok: string | void;
  try { ok = await fn(u); } catch (e) { if (e instanceof SyncError) return { error: e.message }; console.error("[pricelabs]", e instanceof Error ? e.message : e); return { error: "Erreur technique. Rien n'a été modifié." }; }
  revalidatePath("/", "layout");
  return ok ? { ok } : null;
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function connectPriceLabsAction(_: FormState, fd: FormData) {
  return run(async (u) => {
    const r = await connectPriceLabs(u.tenantId, s(fd, "propertyId"), s(fd, "apiKey"), "user:" + u.id);
    if (r.synced) await runDailyReview(u.tenantId, "MANUAL");
    return r.synced ? "Clé vérifiée, annonce rattachée et première lecture effectuée." : `Clé vérifiée : ${r.listings} annonces sur ce compte. Choisissez celle de ce logement.`;
  });
}
export async function selectListingAction(_: FormState, fd: FormData) {
  return run(async (u) => { await selectListing(u.tenantId, s(fd, "propertyId"), s(fd, "listingId")); await runDailyReview(u.tenantId, "MANUAL"); return "Annonce rattachée et première lecture effectuée."; });
}
export async function syncPriceLabsAction(_: FormState, fd: FormData) {
  return run(async (u) => { const r = await syncPriceLabs(u.tenantId, s(fd, "propertyId")); await runDailyReview(u.tenantId, "MANUAL"); return `Lecture terminée : ${r.days} jours de grille, ${r.reservations} réservations. Revue relancée.`; });
}
export async function disconnectPriceLabsAction(_: FormState, fd: FormData) {
  return run(async (u) => { await disconnectPriceLabs(u.tenantId, s(fd, "propertyId"), "user:" + u.id); return "Clé supprimée."; });
}
