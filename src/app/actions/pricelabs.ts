"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { requireUser } from "@/lib/auth";
import { connectPriceLabs, detachListing, disconnectPriceLabs, selectListing, setChannelOverrides, SyncError, syncPriceLabs } from "@/lib/services/pricelabs-sync";
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
    return `Clé vérifiée : ${r.listings} annonce${r.listings > 1 ? "s" : ""} sur ce compte. Confirmez celle de ce logement.`;
  });
}
export async function selectListingAction(_: FormState, fd: FormData) {
  return run(async (u) => { await selectListing(u.tenantId, s(fd, "propertyId"), s(fd, "listingId"), "user:" + u.id); await runDailyReview(u.tenantId, "MANUAL"); return "Annonce rattachée et première lecture effectuée."; });
}
export async function detachListingAction(_: FormState, fd: FormData) {
  return run(async (u) => { await detachListing(u.tenantId, s(fd, "propertyId"), "user:" + u.id); return "Annonce détachée. Choisissez celle de ce logement."; });
}
export async function syncPriceLabsAction(_: FormState, fd: FormData) {
  return run(async (u) => { const r = await syncPriceLabs(u.tenantId, s(fd, "propertyId")); await runDailyReview(u.tenantId, "MANUAL"); return `Lecture terminée : ${r.days} jours de grille, ${r.reservations} réservations. Revue relancée.`; });
}
export async function disconnectPriceLabsAction(_: FormState, fd: FormData) {
  return run(async (u) => { await disconnectPriceLabs(u.tenantId, s(fd, "propertyId"), "user:" + u.id); return "Clé supprimée."; });
}
export async function channelOverridesAction(_: FormState, fd: FormData) {
  return run(async (u) => {
    const choices: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("canal-") && typeof v === "string" && v) choices[k.slice(6)] = v;
    const n = await setChannelOverrides(u.tenantId, s(fd, "propertyId"), choices, "user:" + u.id);
    await runDailyReview(u.tenantId, "MANUAL");
    return `${n} réservation${n > 1 ? "s" : ""} précisée${n > 1 ? "s" : ""}. Lecture et revue relancées.`;
  });
}
