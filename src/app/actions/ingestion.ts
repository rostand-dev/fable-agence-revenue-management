"use server";
import { revalidatePath } from "next/cache";
import type { FormState } from "@/components/forms";
import { maskPii } from "@/lib/privacy/pii";
import { requireUser } from "@/lib/auth";
import { refused } from "@/lib/rights";
import { dismissDelivery, replayAll, replayDelivery } from "@/lib/services/ingestion-errors";
import { SyncError } from "@/lib/services/pricelabs-sync";

async function run(fn: (u: { id: string; tenantId: string }) => Promise<string>): Promise<FormState> {
  const u = await requireUser();
  const no = await refused(u, "property.manage"); if (no) return no;
  let ok: string;
  try { ok = await fn(u); } catch (e) { if (e instanceof SyncError) return { error: e.message }; console.error("[ingestion]", maskPii(e instanceof Error ? e.message : String(e)).slice(0, 300)); return { error: "Erreur technique. Actualisez la page pour voir l'état réel des livraisons." }; }
  revalidatePath("/integrations/erreurs");
  revalidatePath("/integrations");
  return { ok };
}
const s = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function replayDeliveryAction(_: FormState, fd: FormData) {
  return run(async (u) => (await replayDelivery(u.tenantId, "user:" + u.id, s(fd, "id"))).message);
}
export async function replayAllDeliveriesAction(_: FormState, _fd: FormData) {
  return run(async (u) => {
    const r = await replayAll(u.tenantId, "user:" + u.id);
    if (r.replayed === 0) return "Aucune livraison à rejouer.";
    return `${r.replayed} livraison${r.replayed > 1 ? "s" : ""} rejouée${r.replayed > 1 ? "s" : ""} : ${r.applied} appliquée${r.applied > 1 ? "s" : ""}, ${r.failed} toujours en échec${r.remaining ? ". D'autres restent à rejouer : relancez." : "."}`;
  });
}
export async function dismissDeliveryAction(_: FormState, fd: FormData) {
  return run(async (u) => { await dismissDelivery(u.tenantId, "user:" + u.id, s(fd, "id")); return "Livraison écartée."; });
}
